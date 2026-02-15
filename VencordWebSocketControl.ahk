#Requires AutoHotkey v2.0
#NoTrayIcon

class WebSocketServer {
    __New(port := 8125) {
        this.Port := port
        this.Clients := Map()
        this.ServerSock := -1
        this.WM_SOCKET := 0x9988 ; Custom window message
        
        ; Initialize Winsock
        this.WSAData := Buffer(400)
        if (DllCall("Ws2_32\WSAStartup", "UShort", 0x0202, "Ptr", this.WSAData))
            throw Error("WSAStartup failed")

        this.SetupServer()
    }

    __Delete() {
        this.Shutdown()
    }

    Shutdown() {
        if (this.ServerSock != -1) {
            DllCall("Ws2_32\closesocket", "Ptr", this.ServerSock)
            this.ServerSock := -1
        }
        for sock, _ in this.Clients {
            DllCall("Ws2_32\closesocket", "Ptr", sock)
        }
        this.Clients.Clear()
        DllCall("Ws2_32\WSACleanup")
    }

    SetupServer() {
        ; Create socket
        this.ServerSock := DllCall("Ws2_32\socket", "Int", 2, "Int", 1, "Int", 6, "Ptr") ; AF_INET, SOCK_STREAM, IPPROTO_TCP
        if (this.ServerSock == -1)
            throw Error("socket failed")

        ; Bind to 127.0.0.1
        SockAddr := Buffer(16, 0)
        NumPut("UShort", 2, SockAddr, 0) ; AF_INET
        NumPut("UShort", DllCall("Ws2_32\htons", "UShort", this.Port, "UShort"), SockAddr, 2) ; Port
        NumPut("UInt", DllCall("Ws2_32\inet_addr", "AStr", "127.0.0.1", "UInt"), SockAddr, 4) ; IP

        if (DllCall("Ws2_32\bind", "Ptr", this.ServerSock, "Ptr", SockAddr, "Int", 16))
            throw Error("bind failed")

        ; Listen
        if (DllCall("Ws2_32\listen", "Ptr", this.ServerSock, "Int", 5))
            throw Error("listen failed")

        ; Register async events
        OnMessage(this.WM_SOCKET, this.SocketHandler.Bind(this))
        ; FD_ACCEPT (8) | FD_READ (1) | FD_CLOSE (32)
        if (DllCall("Ws2_32\WSAAsyncSelect", "Ptr", this.ServerSock, "Ptr", A_ScriptHwnd, "UInt", this.WM_SOCKET, "Int", 8 | 1 | 32))
            throw Error("WSAAsyncSelect failed")
        
        OutputDebug("WebSocketServer started on port " . this.Port . "`n")
    }

    SocketHandler(wParam, lParam, msg, hwnd) {
        socket := wParam
        event := lParam & 0xFFFF
        error := (lParam >> 16) & 0xFFFF

        if (error) {
            this.Disconnect(socket)
            return
        }

        if (event == 8) { ; FD_ACCEPT
            ClientSock := DllCall("Ws2_32\accept", "Ptr", socket, "Ptr", 0, "Ptr", 0, "Ptr")
            if (ClientSock != -1) {
                ; Register events for client
                DllCall("Ws2_32\WSAAsyncSelect", "Ptr", ClientSock, "Ptr", A_ScriptHwnd, "UInt", this.WM_SOCKET, "Int", 1 | 32) ; READ | CLOSE
                this.Clients[ClientSock] := { HandshakeDone: false }
                OutputDebug("Client connected: " . ClientSock . "`n")
            }
        } else if (event == 1) { ; FD_READ
            this.HandleRead(socket)
        } else if (event == 32) { ; FD_CLOSE
            this.Disconnect(socket)
        }
    }

    HandleRead(socket) {
        if (!this.Clients.Has(socket))
            return

        buf := Buffer(8192)
        received := DllCall("Ws2_32\recv", "Ptr", socket, "Ptr", buf, "Int", 8192, "Int", 0)
        
        if (received <= 0)
            return

        data := StrGet(buf, received, "UTF-8")
        
        if (!this.Clients[socket].HandshakeDone) {
            this.DoHandshake(socket, data)
        } else {
            ; Process frames (ignoring for now as we only send)
            ; If we needed to handle pings or incoming messages, we'd parse frames here
        }
    }

    DoHandshake(socket, data) {
        if (RegExMatch(data, "Sec-WebSocket-Key: (.*)\r\n", &match)) {
            key := match[1]
            magic := "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            acceptKey := this.ComputeAcceptKey(key . magic)
            
            response := "HTTP/1.1 101 Switching Protocols`r`n"
                      . "Upgrade: websocket`r`n"
                      . "Connection: Upgrade`r`n"
                      . "Sec-WebSocket-Accept: " . acceptKey . "`r`n`r`n"
            
            this.SendRaw(socket, response)
            this.Clients[socket].HandshakeDone := true
            OutputDebug("Handshake completed for " . socket . "`n")
        }
    }

    ComputeAcceptKey(str) {
        ; 1. SHA1
        hProv := 0
        hHash := 0
        len := StrPut(str, "UTF-8") - 1
        utf8Buf := Buffer(len)
        StrPut(str, utf8Buf, "UTF-8")

        DllCall("Advapi32\CryptAcquireContext", "Ptr*", &hProv, "Ptr", 0, "Ptr", 0, "UInt", 24, "UInt", 0xF0000000) ; PROV_RSA_FULL, CRYPT_VERIFYCONTEXT
        DllCall("Advapi32\CryptCreateHash", "Ptr", hProv, "UInt", 0x8004, "Ptr", 0, "UInt", 0, "Ptr*", &hHash) ; CALG_SHA1
        DllCall("Advapi32\CryptHashData", "Ptr", hHash, "Ptr", utf8Buf, "UInt", len, "UInt", 0)
        
        hashLen := 20
        hashBuf := Buffer(hashLen)
        DllCall("Advapi32\CryptGetHashParam", "Ptr", hHash, "UInt", 2, "Ptr", hashBuf, "UInt*", &hashLen, "UInt", 0) ; HP_HASHVAL

        ; 2. Base64
        b64Len := 0
        DllCall("Crypt32\CryptBinaryToString", "Ptr", hashBuf, "UInt", hashLen, "UInt", 0x40000001, "Ptr", 0, "UInt*", &b64Len) ; CRYPT_STRING_BASE64 | NOCRLF
        b64Buf := Buffer(b64Len * 2)
        DllCall("Crypt32\CryptBinaryToString", "Ptr", hashBuf, "UInt", hashLen, "UInt", 0x40000001, "Ptr", b64Buf, "UInt*", &b64Len)
        
        DllCall("Advapi32\CryptDestroyHash", "Ptr", hHash)
        DllCall("Advapi32\CryptReleaseContext", "Ptr", hProv, "UInt", 0)
        
        return StrGet(b64Buf)
    }

    SendRaw(socket, str) {
        len := StrPut(str, "UTF-8") - 1
        buf := Buffer(len)
        StrPut(str, buf, "UTF-8")
        DllCall("Ws2_32\send", "Ptr", socket, "Ptr", buf, "Int", len, "Int", 0)
    }

    Broadcast(message) {
        frame := this.MakeFrame(message)
        for sock, client in this.Clients {
            if (client.HandshakeDone) {
                DllCall("Ws2_32\send", "Ptr", sock, "Ptr", frame, "Int", frame.Size, "Int", 0)
            }
        }
    }

    MakeFrame(message) {
        msgLen := StrPut(message, "UTF-8") - 1
        frameBuf := Buffer(10 + msgLen) ; Max header size + payload
        
        ; Byte 0: FIN (1) | RSVP (0) | Opcode (1 = text) -> 1000 0001 -> 0x81
        NumPut("UChar", 0x81, frameBuf, 0)
        
        payloadStart := 0
        if (msgLen < 126) {
            NumPut("UChar", msgLen, frameBuf, 1)
            payloadStart := 2
        } else if (msgLen < 65536) {
            NumPut("UChar", 126, frameBuf, 1)
            NumPut("UShort", DllCall("Ws2_32\htons", "UShort", msgLen, "UShort"), frameBuf, 2)
            payloadStart := 4
        } else {
            ; Not implementing huge frames for this simple control script
            return Buffer(0)
        }
        
        StrPut(message, frameBuf.Ptr + payloadStart, "UTF-8")
        
        ; Resize buffer to actual length
        finalBuf := Buffer(payloadStart + msgLen)
        DllCall("RtlMoveMemory", "Ptr", finalBuf, "Ptr", frameBuf, "UPtr", payloadStart + msgLen)
        
        return finalBuf
    }

    Disconnect(socket) {
        if (this.Clients.Has(socket)) {
            DllCall("Ws2_32\closesocket", "Ptr", socket)
            this.Clients.Delete(socket)
            OutputDebug("Client disconnected: " . socket . "`n")
        }
    }
}

; Create and start the WebSocket server on port 8125
; (Port 8124 is likely used by Macro Deck, so we use the next one)
server := WebSocketServer(8125)

; The '~' prefix allows the key press to pass through to the OS/other apps
~NumLock:: {
    ; Send the toggle command to Vencord
    server.Broadcast('{"command": "TOGGLE_MUTE"}')
}
