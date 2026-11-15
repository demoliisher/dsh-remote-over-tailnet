//go:build js

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"syscall/js"
	"time"

	"tailscale.com/dshwasm/tsnetx"
)

type startOptions struct {
	Dir      string `json:"dir"`
	Hostname string `json:"hostname"`
	AuthKey  string `json:"authKey"`
	Control  string `json:"controlURL"`
	Ephemeral bool  `json:"ephemeral"`
}

type bridge struct {
	mu     sync.Mutex
	srv    *tsnetx.Server
	lastErr  string
	running  bool
	listener net.Listener
	// tailnet 上的 SSH 端口：入站连接整段交给 JS 侧的 SSH 服务，不经过本机套接字。
	streamListener net.Listener
}

func main() {
	b := &bridge{}
	js.Global().Set("dshTsnet", map[string]any{
		"start":   js.FuncOf(b.jsStart),
		"status":  js.FuncOf(b.jsStatus),
		"close":   js.FuncOf(b.jsClose),
		"listen":  js.FuncOf(b.jsListen),
		"listenStream": js.FuncOf(b.jsListenStream),
		"closeStream":  js.FuncOf(b.jsCloseStreamListener),
		"closePrimary": js.FuncOf(b.jsClosePrimaryListener),
		"inbound": js.FuncOf(b.jsInbound),
		"drain":   js.FuncOf(b.jsDrain),
		"closed":  js.FuncOf(b.jsClosedFromJS),
		"probe":   js.FuncOf(b.jsProbe),
	})
	select {}
}

func (b *bridge) jsStart(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return fmt.Sprint("dshTsnet.start 需要一个配置参数")
	}
	var opts startOptions
	if err := json.Unmarshal([]byte(args[0].String()), &opts); err != nil {
		return "配置解析失败：" + err.Error()
	}
	return promise(func(resolve, reject js.Value) {
		err := b.start(context.Background(), opts)
		if err != nil {
			reject.Invoke(err.Error())
			return
		}
		resolve.Invoke(b.statusValue())
	})
}

// promise 把一段阻塞工作包装成 JS Promise，工作在新 goroutine 中执行，避免阻塞 wasm 事件循环。
func promise(work func(resolve, reject js.Value)) js.Value {
	var fn js.Func
	fn = js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer fn.Release()
			work(resolve, reject)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(fn)
}

func (b *bridge) start(ctx context.Context, opts startOptions) error {
	b.mu.Lock()
	if b.srv != nil {
		// 已经启动过：重复 start 直接复用，避免在同一进程里再起一个 netstack。
		b.mu.Unlock()
		return nil
	}
	srv := &tsnetx.Server{
		Dir:      opts.Dir,
		Hostname: opts.Hostname,
		AuthKey:  opts.AuthKey,
		Logf: func(format string, args ...any) {
			js.Global().Get("console").Call("log", "[tsnet] "+fmt.Sprintf(format, args...))
		},
		UserLogf: func(format string, args ...any) {
			js.Global().Get("console").Call("log", "[tsnet-user] "+fmt.Sprintf(format, args...))
		},
	}
	if opts.Control != "" {
		srv.ControlURL = opts.Control
	}
	srv.Ephemeral = opts.Ephemeral
	b.srv = srv
	b.lastErr = ""
	b.mu.Unlock()

	// Up 会一直阻塞到节点真正进入 Running；首次使用时还要等用户在浏览器里完成授权。
	// 把 Up 放到后台执行，这里只等到「已运行」或「拿到授权链接」就先返回，
	// 让面板尽早把链接交给用户；Up 的最终结果由 recordStart 记进状态。
	up := make(chan error, 1)
	go func() {
		_, err := srv.Up(ctx)
		up <- err
	}()
	lc, err := srv.LocalClient()
	if err != nil {
		b.recordStart(err)
		return err
	}
	deadline := time.Now().Add(2 * time.Minute)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-up:
			b.recordStart(err)
			return err
		case <-ticker.C:
			statusCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			st, statusErr := lc.Status(statusCtx)
			cancel()
			if statusErr != nil {
				continue
			}
			if st.BackendState == "Running" {
				b.recordStart(nil)
				return nil
			}
			if st.AuthURL != "" {
				return nil
			}
			if time.Now().After(deadline) {
				err := fmt.Errorf("内嵌节点启动超时：仍未加入 tailnet")
				b.recordStart(err)
				return err
			}
		}
	}
}

// recordStart 记录 Up 的最终结果；未就绪时把错误写进 lastErr，供 status 展示。
func (b *bridge) recordStart(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err == nil {
		b.running = true
		b.lastErr = ""
		return
	}
	b.running = false
	b.lastErr = err.Error()
}

func (b *bridge) statusValue() js.Value {
	b.mu.Lock()
	srv := b.srv
	lastErr := b.lastErr
	running := b.running
	b.mu.Unlock()

	out := map[string]any{"running": running, "error": lastErr}
	if srv == nil {
		out["backendState"] = "NoState"
		return js.ValueOf(out)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		out["error"] = err.Error()
		return js.ValueOf(out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	st, err := lc.Status(ctx)
	if err != nil {
		out["error"] = err.Error()
		return js.ValueOf(out)
	}
	out["backendState"] = st.BackendState
	out["authURL"] = st.AuthURL
	out["version"] = st.Version
	if st.Self != nil {
		out["dnsName"] = st.Self.DNSName
		out["hostName"] = st.Self.HostName
		ips := make([]any, 0, len(st.Self.TailscaleIPs))
		for _, ip := range st.Self.TailscaleIPs {
			ips = append(ips, ip.String())
		}
		out["tailscaleIPs"] = ips
		out["online"] = st.Self.Online
	}
	return js.ValueOf(out)
}

func (b *bridge) jsStatus(this js.Value, args []js.Value) any {
	return b.statusValue()
}

// jsClose 关闭节点。关停要等 accept 循环与各连接收尾，可能长时间不返回，
// 因此放进 goroutine 里做，JS 侧拿到的是 Promise，事件循环不会被卡住。
func (b *bridge) jsClose(this js.Value, args []js.Value) any {
	return promise(func(resolve, reject js.Value) {
		b.mu.Lock()
		srv := b.srv
		ln := b.listener
		streamLn := b.streamListener
		b.srv = nil
		b.listener = nil
		b.streamListener = nil
		b.running = false
		b.mu.Unlock()
		var first string
		for _, target := range []net.Listener{streamLn, ln} {
			if target == nil {
				continue
			}
			if err := target.Close(); err != nil && first == "" {
				first = err.Error()
			}
		}
		if srv != nil {
			if err := srv.Close(); err != nil && first == "" {
				first = err.Error()
			}
		}
		if first != "" {
			resolve.Invoke(js.ValueOf(first))
			return
		}
		resolve.Invoke(js.Null())
	})
}
