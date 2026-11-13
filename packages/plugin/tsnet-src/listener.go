//go:build js

package main

import (
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"syscall/js"
)

type jsConn struct {
	id     int32
	conn   net.Conn
	inCh   chan []byte
	drain  chan struct{}
	mu     sync.Mutex
	closed bool
}

var (
	connsMu    sync.Mutex
	conns      = map[int32]*jsConn{}
	nextConnID int32
)

func dshNet() js.Value { return js.Global().Get("dshNet") }

func bytesToJS(data []byte) js.Value {
	arr := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(arr, data)
	return arr
}

// jsListen 在 tailnet 上监听指定端口，并把每个入站连接转交给 JS 侧拨号到本机 targetPort。
func (b *bridge) jsListen(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		return "dshTsnet.listen 需要 tailPort 与 targetPort 两个参数"
	}
	tailPort := args[0].Int()
	targetPort := args[1].Int()
	b.mu.Lock()
	srv := b.srv
	b.mu.Unlock()
	if srv == nil {
		return "tsnet 尚未启动，无法监听"
	}
	return promise(func(resolve, reject js.Value) {
		ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", tailPort))
		if err != nil {
			reject.Invoke(err.Error())
			return
		}
		b.mu.Lock()
		b.listener = ln
		b.mu.Unlock()
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				id := atomic.AddInt32(&nextConnID, 1)
				jc := &jsConn{id: id, conn: conn, inCh: make(chan []byte, 128), drain: make(chan struct{}, 1)}
				connsMu.Lock()
				conns[id] = jc
				connsMu.Unlock()
				dial := dshNet().Call("dial", id, "127.0.0.1", targetPort)
				if !dial.Bool() {
					connsMu.Lock()
					delete(conns, id)
					connsMu.Unlock()
					conn.Close()
					continue
				}
				go jc.pump()
			}
		}()
		// 成功时返回数字端口，JS 侧按数字解析；只有失败才走 reject 的字符串。
		resolve.Invoke(tailPort)
	})
}

func (c *jsConn) pump() {
	errCh := make(chan error, 2)
	// tailnet 入站到本机：读到数据后写入 JS 侧的 socket。
	go func() {
		buf := make([]byte, 16*1024)
		for {
			n, err := c.conn.Read(buf)
			if n > 0 {
				data := append([]byte(nil), buf[:n]...)
				if !dshNet().Call("send", c.id, bytesToJS(data)).Bool() {
					<-c.drain
				}
			}
			if err != nil {
				errCh <- err
				return
			}
		}
	}()
	// 本机出站到 tailnet：把 JS 侧读到的数据写回 tsnet 连接。
	go func() {
		for data := range c.inCh {
			if _, err := c.conn.Write(data); err != nil {
				errCh <- err
				return
			}
			dshNet().Call("resume", c.id)
		}
	}()
	<-errCh
	connsMu.Lock()
	delete(conns, c.id)
	close(c.inCh)
	connsMu.Unlock()
	c.conn.Close()
	dshNet().Call("close", c.id)
}

func (b *bridge) jsInbound(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		return false
	}
	id := int32(args[0].Int())
	arr := args[1]
	data := make([]byte, arr.Length())
	js.CopyBytesToGo(data, arr)
	connsMu.Lock()
	defer connsMu.Unlock()
	jc, ok := conns[id]
	if !ok || jc.closed {
		return false
	}
	select {
	case jc.inCh <- data:
		return true
	default:
		return false
	}
}

func (b *bridge) jsDrain(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return nil
	}
	id := int32(args[0].Int())
	connsMu.Lock()
	jc, ok := conns[id]
	connsMu.Unlock()
	if ok {
		select {
		case jc.drain <- struct{}{}:
		default:
		}
	}
	return nil
}

func (b *bridge) jsClosedFromJS(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return nil
	}
	id := int32(args[0].Int())
	connsMu.Lock()
	jc, ok := conns[id]
	if ok {
		jc.closed = true
		delete(conns, id)
	}
	connsMu.Unlock()
	if ok {
		jc.conn.Close()
	}
	return nil
}

func (b *bridge) jsCloseListener(this js.Value, args []js.Value) any {
	b.mu.Lock()
	ln := b.listener
	b.listener = nil
	b.mu.Unlock()
	if ln != nil {
		return ln.Close().Error()
	}
	return nil
}
