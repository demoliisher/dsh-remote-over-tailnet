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

// errValue 把错误转成 JS 侧可以直接判断的值：成功给 null，失败给字符串。
func errValue(err error) js.Value {
	if err == nil {
		return js.Null()
	}
	return js.ValueOf(err.Error())
}

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
	return b.listenOnTail(tailPort, true, func(id int32) bool {
		return dshNet().Call("dial", id, "127.0.0.1", targetPort).Bool()
	})
}

// jsListenStream 在 tailnet 上监听指定端口，把每个入站连接原样交给 JS 侧；
// SSH 服务在 Node 里直接接管这条字节流，不需要本机再有一个套接字。
func (b *bridge) jsListenStream(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return "dshTsnet.listenStream 需要 tailPort 参数"
	}
	tailPort := args[0].Int()
	return b.listenOnTail(tailPort, false, func(id int32) bool {
		return dshNet().Call("accept", id, tailPort).Bool()
	})
}

// listenOnTail 在 tailnet 端口上监听；attach 决定每个入站连接交给 JS 侧做什么，
// 返回 false 表示 JS 拒收，连接随即关闭。
func (b *bridge) listenOnTail(tailPort int, primary bool, attach func(id int32) bool) any {
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
		if primary {
			b.listener = ln
		} else {
			b.streamListener = ln
		}
		b.mu.Unlock()
		go b.acceptConns(ln, attach)
		// 成功时返回数字端口，JS 侧按数字解析；只有失败才走 reject 的字符串。
		resolve.Invoke(tailPort)
	})
}

func (b *bridge) acceptConns(ln net.Listener, attach func(id int32) bool) {
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
		if !attach(id) {
			connsMu.Lock()
			delete(conns, id)
			connsMu.Unlock()
			conn.Close()
			continue
		}
		go jc.pump()
	}
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

// jsCloseStreamListener 只关闭 SSH 这类原始流端口，不动主中继监听。
// 关停要等该端口的 accept 循环退出，放进 goroutine 里做，JS 侧拿 Promise。
func (b *bridge) jsCloseStreamListener(this js.Value, args []js.Value) any {
	return promise(func(resolve, reject js.Value) {
		b.mu.Lock()
		ln := b.streamListener
		b.streamListener = nil
		b.mu.Unlock()
		if ln == nil {
			resolve.Invoke(js.Null())
			return
		}
		resolve.Invoke(errValue(ln.Close()))
	})
}

// jsClosePrimaryListener 只关闭中继端口的监听，节点与 SSH 端口都保持原样。
func (b *bridge) jsClosePrimaryListener(this js.Value, args []js.Value) any {
	return promise(func(resolve, reject js.Value) {
		b.mu.Lock()
		ln := b.listener
		b.listener = nil
		b.mu.Unlock()
		if ln == nil {
			resolve.Invoke(js.Null())
			return
		}
		resolve.Invoke(errValue(ln.Close()))
	})
}
