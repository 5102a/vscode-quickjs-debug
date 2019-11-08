import * as CP from 'child_process';
import { AddressInfo, Server, Socket } from 'net';
import { basename } from 'path';
import { InitializedEvent, Logger, logger, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
const path = require('path');
const Parser = require('stream-parser');
const Transform = require('stream').Transform;
const fs = require('fs');

/**
 * This interface describes the quickjs-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the quickjs-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Optional arguments passed to the debuggee. */
	args?: string[];
	/** Launch the debuggee in this working directory (specified as an absolute path). If omitted the debuggee is lauched in its own directory. */
	cwd?: string;
	/** Absolute path to the runtime executable to be used. Default is the runtime executable on the PATH. */
	runtimeExecutable: string;
	/** The port the debug extension listens on to accept incoming sessions. */
	port: number;
	/** Run the extension and wait for QuickJS to attach. */
	attach: boolean;
	localRoot: string;
	/** Where to launch the debug target. */
	console?: ConsoleType;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

/**
 * Messages from the qjs binary are in big endian length prefix json payloads.
 * The protocol is roughly just the JSON stringification of the requests.
 * Responses are intercepted to translate references into thread scoped references.
 */
class MessageParser extends Transform {
	constructor() {
		super();
		this._bytes(9, this.onLength);
	}

	private onLength(buffer: Buffer) {
		var length = parseInt(buffer.toString(), 16);
		this.emit('length', length);
		this._bytes(length, this.onMessage);
	}

	private onMessage(buffer: Buffer) {
		var json = JSON.parse(buffer.toString());
		this.emit('message', json);
		this._bytes(9, this.onLength);
	}
}
Parser(MessageParser.prototype);

type ConsoleType = 'internalConsole' | 'integratedTerminal' | 'externalTerminal';

interface PendingResponse {
	resolve: Function;
	reject: Function;
}

export class QuickJSDebugSession extends LoggingDebugSession {
	private static RUNINTERMINAL_TIMEOUT = 5000;

	private _server?: Server;
	private _supportsRunInTerminalRequest = false;
	private _console: ConsoleType = 'internalConsole';
	private _isTerminated: boolean;
	private _threads = new Map<number, Socket>();
	private _requests = new Map<number, PendingResponse>();
	private _breakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
	private _stopOnException = false;
	private _stackFrames = new Map<number, number>();
	private _variables = new Map<number, number>();
	private _localRoot: string;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("quickjs-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (typeof args.supportsRunInTerminalRequest === 'boolean') {
			this._supportsRunInTerminalRequest = args.supportsRunInTerminalRequest;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;
		response.body.exceptionBreakpointFilters = [{
			label: "All Exceptions",
			filter: "exceptions",
		}]

		// make VS Code to support data breakpoints
		// response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		// response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		// response.body.supportsBreakpointLocationsRequest = true;

		response.body.supportsTerminateRequest = true;

		this.sendResponse(response);

		this.sendEvent(new InitializedEvent());
	}

	private handleEvent(thread: number, event: any) {
		if (event.type === 'StoppedEvent') {
			if (event.reason === 'entry')
				this.sendThreadMessage(thread, { type: 'continue' })
			else
				this.sendEvent(new StoppedEvent(event.reason, thread));
		}
	}

	private handleResponse(json: any) {
		var request_seq: number = json.request_seq;
		var pending = this._requests.get(request_seq);
		if (!pending) {
			this.log(`request not found: ${request_seq}`)
			return;
		}
		this._requests.delete(request_seq);
		if (json.error)
			pending.reject(new Error(json.error));
		else
			pending.resolve(json.body);
	}

	private newSession(thread: number) {
		this._breakpoints.forEach((breakpoints, path) => {
			this.sendBreakpointMessage(thread, path, breakpoints);
		});
		this.sendThreadMessage(thread, {
			type: 'stopOnException',
			stopOnException: this._stopOnException,
		})
	}

	private onSocket(socket: Socket) {
		var parser = new MessageParser();
		var thread: number = 0;
		parser.on('message', json => {
			// the very first message must include the thread id.
			if (!thread) {
				thread = json.event.thread;
				this._threads.set(thread, socket);
				this.newSession(thread);
			}

			if (json.type === 'event') {
				this.handleEvent(thread, json.event);
			}
			else if (json.type === 'response') {
				this.handleResponse(json);
			}
			else {
				this.log(`unknown message ${json.type}`);
			}
		});
		socket.on('close', () => {
			if (thread) {
				// todo: terminate?
				this._threads.delete(thread);
			}
		});
		socket.pipe(parser as any);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		this._localRoot = args.localRoot;

		this.closeServer();
		this._server = new Server(this.onSocket.bind(this));
		this._server.listen(args.port || 0);
		var port = (<AddressInfo>this._server.address()).port;
		this.log(`QuickJS Debug port: ${port}`);

		var cwd = <string>args.cwd || path.dirname(args.program);
		var env = {
			QUICKJS_DEBUG_ADDRESS: `localhost:${port}`
		}

		if (typeof args.console === 'string') {
			switch (args.console) {
				case 'internalConsole':
				case 'integratedTerminal':
				case 'externalTerminal':
					this._console = args.console;
					break;
				default:
					this.sendErrorResponse(response, 2028, `Unknown console type '${args.console}'.`);
					return;
			}
		}

		let qjsArgs = (args.args || []).slice();
		qjsArgs.unshift(args.program);

		if (!args.attach) {
			if (this._supportsRunInTerminalRequest && (this._console === 'externalTerminal' || this._console === 'integratedTerminal')) {

				const termArgs: DebugProtocol.RunInTerminalRequestArguments = {
					kind: this._console === 'integratedTerminal' ? 'integrated' : 'external',
					title: "QuickJS Debug Console",
					cwd,
					args: qjsArgs,
					env,
				};

				this.runInTerminalRequest(termArgs, QuickJSDebugSession.RUNINTERMINAL_TIMEOUT, runResponse => {
					if (runResponse.success) {
						// this._attach(response, args, port, address, timeout);
					} else {
						this.sendErrorResponse(response, 2011, `Cannot launch debug target in terminal (${runResponse.message}).`);
						// this._terminated('terminal error: ' + runResponse.message);
					}
				});
			} else {
				const options: CP.SpawnOptions = {
					cwd,
					env,
				};

				const nodeProcess = CP.spawn(args.runtimeExecutable, qjsArgs, options);
				nodeProcess.on('error', (error) => {
					// tslint:disable-next-line:no-bitwise
					this.sendErrorResponse(response, 2017, `Cannot launch debug target (${error.message}).`);
					this._terminated(`failed to launch target (${error})`);
				});
				nodeProcess.on('exit', () => {
					this._terminated('target exited');
				});
				nodeProcess.on('close', (code) => {
					this._terminated('target closed');
				});

				this._captureOutput(nodeProcess);
			}
		}


		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		this.sendResponse(response);
	}


	private _captureOutput(process: CP.ChildProcess) {
		process.stdout.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		process.stderr.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});
	}

	public log(message: string) {
		this.sendEvent(new OutputEvent(message + '\n', 'console'));

	}

	private _terminated(reason: string): void {
		this.log(`_terminated: ${reason}`);
		this.closeServer();

		if (!this._isTerminated) {
			this._isTerminated = true;
			this.sendEvent(new TerminatedEvent());
		}
	}

	private async closeServer() {
		if (this._server) {
			this._server.close();
			this._server = undefined;
		}
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
		this.closeServer();
		this.sendResponse(response);
	}

	private sendBreakpointMessage(thread: number, path: string, breakpoints?: DebugProtocol.SourceBreakpoint[]) {
		if (this._localRoot && path.startsWith(this._localRoot))
			path = path.replace(this._localRoot, '')
		var envelope = {
			type: 'breakpoints',
			breakpoints: {
				path,
				breakpoints,
			}
		};
		this.sendThreadMessage(thread, envelope);
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request) {
		// ??
		this.sendResponse(response);

		this._stopOnException = args.filters.length > 0;

		for (var thread of this._threads.keys()) {
			this.sendThreadMessage(thread, {
				type: 'stopOnException',
				stopOnException: this._stopOnException,
			})
		}
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		response.body = {
			breakpoints: []
		};
		this.sendResponse(response);

		if (!args.source.path)
			return;

		if (args.breakpoints) {
			args.breakpoints.sort((a, b) => a.line - b.line);
			this._breakpoints.set(args.source.path, args.breakpoints);
		}
		else {
			this._breakpoints.delete(args.source.path);
		}

		for (var thread of this._threads.keys()) {
			this.sendBreakpointMessage(thread, args.source.path, args.breakpoints)
		}
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: Array.from(this._threads.keys()).map(thread => new Thread(thread, `thread 0x${thread.toString(16)}`))
		}
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		const thread = args.threadId;
		const body = await this.sendThreadRequest(args.threadId, response, args);

		const stackFrames = body.map(({ id, name, filename, line, column }) => {
			const source = filename ? this.createSource(filename) : undefined;
			var mappedId = id + thread;
			this._stackFrames.set(mappedId, thread);
			return new StackFrame(mappedId, name, source, line, column);
		});
		const totalFrames = body.length;

		response.body = {
			stackFrames,
			totalFrames,
		};
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		const thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}
		args.frameId -= thread;
		const body = await this.sendThreadRequest(thread, response, args);
		const scopes = body.map(({ name, reference, expensive }) => {
			// todo: use counter mapping
			var mappedReference = reference + thread;
			this._variables.set(mappedReference, thread);
			return new Scope(name, mappedReference, expensive);
		});

		response.body = {
			scopes,
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		const thread = this._variables.get(args.variablesReference);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}

		args.variablesReference -= thread;
		const body = await this.sendThreadRequest(thread, response, args);
		const variables = body.map(({ name, value, type, variablesReference, indexedVariables }) => {
			// todo: use counter mapping
			variablesReference = variablesReference ? variablesReference + thread : 0;
			this._variables.set(variablesReference, thread);
			return { name, value, type, variablesReference, indexedVariables };
		});

		response.body = {
			variables,
		}
		this.sendResponse(response);
	}

	private sendThreadMessage(thread: number, envelope: any) {
		var socket = this._threads.get(thread);
		if (!socket) {
			this.log(`socket not found for thread: ${thread.toString(16)}`);
			return;
		}

		var json = JSON.stringify(envelope);

		var jsonBuffer = Buffer.from(json);
		// length prefix is 8 hex followed by newline = 012345678\n
		// not efficient, but protocol is then human readable.
		// json = 1 line json + new line
		var messageLength = jsonBuffer.byteLength + 1;
		var length = '00000000' + messageLength.toString(16) + '\n';
		length = length.substr(length.length - 9);
		var lengthBuffer = Buffer.from(length);
		var newline = Buffer.from('\n');
		var buffer = Buffer.concat([lengthBuffer, jsonBuffer, newline]);
		socket.write(buffer);
	}

	private sendThreadRequest(thread: number, response: DebugProtocol.Response, args: any): Promise<any> {
		return new Promise((resolve, reject) => {
			var request_seq = response.request_seq;
			// todo: don't actually need to cache this. can send across wire.
			this._requests.set(request_seq, {
				resolve,
				reject,
			});

			var envelope = {
				type: 'request',
				request: {
					request_seq,
					command: response.command,
					args,
				}
			};

			this.sendThreadMessage(thread, envelope);
		});
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		if (!args.frameId) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: frameId not specified');
			return;
		}
		var thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}
		args.frameId -= thread;

		const body = await this.sendThreadRequest(thread, response, args);
		let variablesReference = body.variablesReference;
		variablesReference = variablesReference ? variablesReference + thread : 0;
		this._variables.set(variablesReference, thread);
		body.variablesReference = variablesReference;

		response.body = await this.sendThreadRequest(thread, response, args);
		this.sendResponse(response);
	}

    protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments) {
		if (!args.frameId) {
			this.sendErrorResponse(response, 2030, 'completionsRequest: frameId not specified');
			return;
		}
		var thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'completionsRequest: thread not found');
			return;
		}
		args.frameId -= thread;

		var expression = args.text.substr(0, args.text.length - 1);
		if (!expression) {
			this.sendErrorResponse(response, 2032, "no completion available for empty string")
			return;
		}

		const evaluateArgs: DebugProtocol.EvaluateArguments = {
			frameId: args.frameId,
			expression,
		}
		response.command = 'evaluate';

		var body = await this.sendThreadRequest(thread, response, evaluateArgs);
		if (!body.variablesReference) {
			this.sendErrorResponse(response, 2032, "no completion available for expression");
			return;
		}

		if (body.indexedVariables !== undefined) {
			this.sendErrorResponse(response, 2032, "no completion available for arrays");
			return;
		}

		const variableArgs: DebugProtocol.VariablesArguments = {
			variablesReference: body.variablesReference,
		}
		response.command = 'variables';
		body = await this.sendThreadRequest(thread, response, variableArgs);

		response.command = 'completions';
		response.body = {
			targets: body.map(property => ({
				label: property.name,
				type: 'field',
			}))
		}

		this.sendResponse(response);
	}

	private createSource(filePath: string): Source {
		if (!fs.existsSync(filePath) && this._localRoot)
			filePath = filePath = path.join(this._localRoot, filePath);
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath));
	}
}
