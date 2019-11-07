# Framing

The debugger protocol messages are framed similarly to chunked encoding and is human readable:

```
<8 character hex length>\n<message of hex length bytes>
```

For example, sending hello world:

```
0000000B\nhello world
```

# JSON Message Framing

Protocol messages are sent as JSON.

```
00000019\n{"message": "hello world"}
```

For on the wire readability, the JSON messages may be ended with a new line:

```
0000001A\n{"message": "hello world"}\n
```

So when viewing it in sniffer, the message would look as follows in the console (newlines are printed):

```
0000001A
{"message": "hello world"}
```
