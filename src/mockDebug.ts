/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as CP from 'child_process';
import { AddressInfo, Server, Socket } from 'net';
import { basename } from 'path';
import { InitializedEvent, Logger, logger, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
const { Subject } = require('await-notify');
const path = require('path');
const Parser = require('stream-parser');
const Transform = require('stream').Transform;

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
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
	/** Where to launch the debug target. */
	console?: ConsoleType;

	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

class MessageParser extends Transform {
	constructor() {
		super();
		this._bytes(4, this.onLength);
	}

	private onLength(buffer: Buffer) {
		var length = buffer.readUInt32BE(0);
		this._bytes(length, this.onMessage);
	}

	private onMessage(buffer: Buffer) {
		var json = JSON.parse(buffer.toString());
		this.emit('message', json);
		this._bytes(4, this.onLength);
	}
}
Parser(MessageParser.prototype);

type ConsoleType = 'internalConsole' | 'integratedTerminal' | 'externalTerminal';

export class MockDebugSession extends LoggingDebugSession {
	private static RUNINTERMINAL_TIMEOUT = 5000;

	private _configurationDone = new Subject();

	private _server?: Server;
	private _supportsRunInTerminalRequest = false;
	private _console: ConsoleType = 'internalConsole';
	private _isTerminated: boolean;
	private _threads = new Map<number, Socket>();
	private _requests = new Map<number, DebugProtocol.Response>();
	private _breakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
	private _stackFrames = new Map<number, number>();
	private _variables = new Map<number, number>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

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

		// the adapter implements the configurationDoneRequest.
		// response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		// response.body.supportsStepBack = true;

		// make VS Code to support data breakpoints
		// response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		// response.body.supportsCompletionsRequest = true;
		// response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		// response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		// response.body.supportsBreakpointLocationsRequest = true;

		response.body.supportsTerminateRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	private handleEvent(thread: number, event: any) {
		if (event.type === 'StoppedEvent') {
			if (event.reason === 'entry')
				this.sendThreadMessage(thread, { type: 'continue' })
			else
				this.sendEvent(new StoppedEvent(event.reason, thread));
		}
	}

	private handleResponse(thread: number, json: any) {
		var request_seq: number = json.request_seq;
		var response = this._requests.get(request_seq);
		if (!response) {
			this.log(`request not found: ${request_seq}`)
			return;
		}
		this._requests.delete(request_seq);

		var body = json.body;
		if (response.command === 'stackTrace') {
			const stackFrames = body.map(({id, name, filename, line, column} )=> {
				const source = filename ? this.createSource(filename) : undefined;
				var mappedId = id + thread;
				this._stackFrames.set(mappedId, thread);
				return new StackFrame(mappedId, name, source, line, column);
			});
			const totalFrames = json.body.length;
			body = {
				stackFrames,
				totalFrames,
			}
		}
		else if (response.command == 'scopes') {
			const scopes = body.map(({name, reference, expensive} )=> {
				// todo: use counter mapping
				var mappedReference = reference + thread;
				this._variables.set(mappedReference, thread);
				return new Scope(name, mappedReference, expensive);
			});

			body = {
				scopes,
			}
		}
		else if (response.command == 'variables') {
			const variables = body.map(({name, value, type, variablesReference, indexedVariables} )=> {
				// todo: use counter mapping
				variablesReference = variablesReference ? variablesReference + thread : 0;
				this._variables.set(variablesReference, thread);
				return {name, value, type, variablesReference, indexedVariables};
			});

			body = {
				variables,
			}
		}

		response.body = body;
		if (json.error)
			this.sendErrorResponse(response, json.error);
		else
			this.sendResponse(response);
	}

	private newSession(thread: number) {
		this._breakpoints.forEach((breakpoints, path) => {
			this.sendBreakpointMessage(thread, path, breakpoints);
		});
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
				this.handleResponse(thread, json);
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
		this.closeServer();
		this._server = new Server(this.onSocket.bind(this));
		this._server.listen(5555);
		var port = (<AddressInfo> this._server.address()).port;
		this.log(`port: ${port}`);

		var cwd = <string> args.cwd || path.dirname(args.program);
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

		if (this._supportsRunInTerminalRequest && (this._console === 'externalTerminal' || this._console === 'integratedTerminal')) {

			const termArgs : DebugProtocol.RunInTerminalRequestArguments = {
				kind: this._console === 'integratedTerminal' ? 'integrated' : 'external',
				title: "QuickJS Debug Console",
				cwd,
				args: qjsArgs,
				env,
			};

			this.runInTerminalRequest(termArgs, MockDebugSession.RUNINTERMINAL_TIMEOUT, runResponse => {
				if (runResponse.success) {
					// this._attach(response, args, port, address, timeout);
				} else {
					this.sendErrorResponse(response, 2011, `Cannot launch debug target in terminal (${runResponse.message}).`);
					// this._terminated('terminal error: ' + runResponse.message);
				}
			});

		} else {
			// this._sendLaunchCommandToConsole(launchArgs);

			// const options: CP.SpawnOptions = {
			// 	cwd,
			// 	env,
			// };

			// const nodeProcess = CP.spawn(args.runtimeExecutable, qjsArgs, options);
			// nodeProcess.on('error', (error) => {
			// 	// tslint:disable-next-line:no-bitwise
			// 	this.sendErrorResponse(response, 2017, `Cannot launch debug target (${error.message}).`);
			// 	this._terminated(`failed to launch target (${error})`);
			// });
			// nodeProcess.on('exit', () => {
			// 	this._terminated('target exited');
			// });
			// nodeProcess.on('close', (code) => {
			// 	this._terminated('target closed');
			// });

			// // this._processId = nodeProcess.pid;

			// this._captureOutput(nodeProcess);

			// if (this._noDebug) {
			// 	this.sendResponse(response);
			// } else {
			// 	this._attach(response, args, port, address, timeout);
			// }
		}


		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		this.sendResponse(response);
	}


	private _captureOutput(process: CP.ChildProcess) {
		process.stdout.on('data', (data: string) => {
			// this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		process.stderr.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});
	}

	public log(message: string) {
		this.sendEvent(new OutputEvent(message + '\n', 'console'));

	}

	/**
	 * The debug session has terminated.
	 */
	private _terminated(reason: string): void {
		this.log(`_terminated: ${reason}`);

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
		var envelope = {
			type: 'breakpoints',
			breakpoints: {
				path,
				breakpoints,
			}
		};
		this.sendThreadMessage(thread, envelope);
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

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.sendThreadRequest(args.threadId, response, args);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		var thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}
		args.frameId -= thread;
		this.sendThreadRequest(thread, response, args);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		const thread = this._variables.get(args.variablesReference);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}

		args.variablesReference -= thread;
		this.sendThreadRequest(thread, response, args);
	}

	private sendThreadMessage(thread: number, envelope: any) {
		var socket = this._threads.get(thread);
		if (!socket) {
			this.log(`socket not found for thread: ${thread.toString(16)}`);
			return;
		}

		var json = JSON.stringify(envelope);

		var jsonBuffer = Buffer.from(json);
		var lengthBuffer = Buffer.alloc(4);
		lengthBuffer.writeUInt32BE(jsonBuffer.byteLength, 0);
		var buffer = Buffer.concat([lengthBuffer, jsonBuffer]);
		socket.write(buffer);
	}

	private sendThreadRequest(thread: number, response: DebugProtocol.Response, args: any) {
		var request_seq = response.request_seq;
		// todo: don't actually need to cache this. can send across wire.
		this._requests.set(request_seq, response);

		var envelope = {
			type: 'request',
			request: {
				request_seq,
				command: response.command,
				args,
			}
		};

		this.sendThreadMessage(thread, envelope);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendThreadRequest(args.threadId, response, args);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.sendThreadRequest(args.threadId, response, args);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
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

		this.sendThreadRequest(thread, response, args);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01"
				},
				{
					label: "item 2",
					sortText: "02"
				}
			]
		};
		this.sendResponse(response);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}
