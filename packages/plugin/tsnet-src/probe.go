//go:build js

package main

import (
	"context"
	"io"
	"net/http"
	"syscall/js"
	"time"
)

// jsProbe 用 tsnet 自带的 HTTP 客户端访问一个 tailnet 地址，用来在没有第二台设备时自测入站链路。
func (b *bridge) jsProbe(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return "dshTsnet.probe 需要一个 URL"
	}
	url := args[0].String()
	b.mu.Lock()
	srv := b.srv
	b.mu.Unlock()
	if srv == nil {
		return "tsnet 尚未启动，无法探测"
	}
	return promise(func(resolve, reject js.Value) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			reject.Invoke(err.Error())
			return
		}
		resp, err := srv.HTTPClient().Do(req)
		if err != nil {
			reject.Invoke(err.Error())
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			reject.Invoke(err.Error())
			return
		}
		resolve.Invoke(js.ValueOf(map[string]any{
			"status": resp.StatusCode,
			"body":   string(body),
		}))
	})
}
