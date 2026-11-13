//go:build js

package tsnetx

import (
	"crypto/tls"
	"errors"
	"net"
)

// FunnelOption 是 ListenFunnel 的配置项。js/wasm 下不支持 Funnel，仅保留签名以便跨平台调用。
type FunnelOption interface {
	funnelOption()
}

type funnelOnly struct{}

func (funnelOnly) funnelOption() {}

func FunnelOnly() FunnelOption { return funnelOnly{} }

type funnelTLSConfig struct{ conf *tls.Config }

func (funnelTLSConfig) funnelOption() {}

func FunnelTLSConfig(conf *tls.Config) FunnelOption { return funnelTLSConfig{conf: conf} }

var errTLSUnsupported = errors.New("tsnetx: js/wasm 构建不提供 ListenTLS")

var errFunnelUnsupported = errors.New("tsnetx: js/wasm 构建不提供 ListenFunnel")

// ListenTLS 在 js/wasm 下不可用：证书接口 client/local.GetCertificate 在 js 构建中被排除。
func (s *Server) ListenTLS(network, addr string) (net.Listener, error) {
	return nil, errTLSUnsupported
}

// ListenFunnel 在 js/wasm 下不可用，与 ListenTLS 同源。
func (s *Server) ListenFunnel(network, addr string, opts ...FunnelOption) (net.Listener, error) {
	return nil, errFunnelUnsupported
}
