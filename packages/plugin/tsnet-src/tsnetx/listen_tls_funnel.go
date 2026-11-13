//go:build !js

package tsnetx

// ListenTLS announces only on the Tailscale network.
// It returns a TLS listener wrapping the tsnet listener.
// It will start the server if it has not been started yet.
func (s *Server) ListenTLS(network, addr string) (net.Listener, error) {
	if network != "tcp" {
		return nil, fmt.Errorf("ListenTLS(%q, %q): only tcp is supported", network, addr)
	}
	ctx := context.Background()
	st, err := s.Up(ctx)
	if err != nil {
		return nil, err
	}
	if !st.CurrentTailnet.MagicDNSEnabled {
		return nil, errors.New("tsnet: you must enable MagicDNS in the DNS page of the admin panel to proceed. See https://tailscale.com/s/https")
	}
	if len(st.CertDomains) == 0 {
		return nil, errors.New("tsnet: you must enable HTTPS in the admin panel to proceed. See https://tailscale.com/s/https")
	}

	ln, err := s.listen(network, addr, listenOnTailnet)
	if err != nil {
		return nil, err
	}
	return tls.NewListener(ln, &tls.Config{
		GetCertificate: s.getCert,
	}), nil
}

// RegisterFallbackTCPHandler registers a callback which will be called
// to handle a TCP flow to this tsnet node, for which no listeners will handle.
//
// If multiple fallback handlers are registered, they will be called in an
// undefined order. See FallbackTCPHandler for details on handling a flow.
//
// The returned function can be used to deregister this callback.
func (s *Server) RegisterFallbackTCPHandler(cb FallbackTCPHandler) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	hnd := s.fallbackTCPHandlers.Add(cb)
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.fallbackTCPHandlers, hnd)
	}
}

// getCert is the GetCertificate function used by ListenTLS.
//
// It calls GetCertificate on the localClient, passing in the ClientHelloInfo.
// For testing, if s.getCertForTesting is set, it will call that instead.
func (s *Server) getCert(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
	lc, err := s.LocalClient()
	if err != nil {
		return nil, err
	}
	return lc.GetCertificate(hi)
}

// FunnelOption is an option passed to ListenFunnel to configure the listener.
type FunnelOption interface {
	funnelOption()
}

type funnelOnly struct{}

func (funnelOnly) funnelOption() {}

// FunnelOnly configures the listener to only respond to connections from Tailscale Funnel.
// The local tailnet will not be able to connect to the listener.
func FunnelOnly() FunnelOption { return funnelOnly{} }

type funnelTLSConfig struct{ conf *tls.Config }

func (f funnelTLSConfig) funnelOption() {}

// FunnelTLSConfig configures the TLS configuration for [Server.ListenFunnel]
//
// This is rarely needed but can permit requiring client certificates, specific
// ciphers suites, etc.
//
// The provided conf should at least be able to get a certificate, setting
// GetCertificate, Certificates or GetConfigForClient appropriately.
// The most common configuration is to set GetCertificate to
// Server.LocalClient's GetCertificate method.
//
// Unless [FunnelOnly] is also used, the configuration is also used for
// in-tailnet connections that don't arrive over Funnel.
func FunnelTLSConfig(conf *tls.Config) FunnelOption {
	return funnelTLSConfig{conf: conf}
}

// ListenFunnel announces on the public internet using Tailscale Funnel.
//
// It also by default listens on your local tailnet, so connections can
// come from either inside or outside your network. To restrict connections
// to be just from the internet, use the FunnelOnly option.
//
// Currently (2023-03-10), Funnel only supports TCP on ports 443, 8443, and 10000.
// The supported host name is limited to that configured for the tsnet.Server.
// As such, the standard way to create funnel is:
//
//	s.ListenFunnel("tcp", ":443")
//
// and the only other supported addrs currently are ":8443" and ":10000".
//
// It will start the server if it has not been started yet.
func (s *Server) ListenFunnel(network, addr string, opts ...FunnelOption) (net.Listener, error) {
	if network != "tcp" {
		return nil, fmt.Errorf("ListenFunnel(%q, %q): only tcp is supported", network, addr)
	}
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host != "" {
		return nil, fmt.Errorf("ListenFunnel(%q, %q): host must be empty", network, addr)
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return nil, err
	}

	// Process, validate opts.
	lnOn := listenOnBoth
	var tlsConfig *tls.Config
	for _, opt := range opts {
		switch v := opt.(type) {
		case funnelTLSConfig:
			if v.conf == nil {
				return nil, errors.New("invalid nil FunnelTLSConfig")
			}
			tlsConfig = v.conf
		case funnelOnly:
			lnOn = listenOnFunnel
		default:
			return nil, fmt.Errorf("unknown opts FunnelOption type %T", v)
		}
	}
	if tlsConfig == nil {
		tlsConfig = &tls.Config{GetCertificate: s.getCert}
	}

	ctx := context.Background()
	st, err := s.Up(ctx)
	if err != nil {
		return nil, err
	}
	// TODO(sonia,tailscale/corp#10577): We may want to use the interactive enable
	// flow here instead of CheckFunnelAccess to allow the user to turn on Funnel
	// if not already on. Specifically when running from a terminal.
	// See cli.serveEnv.verifyFunnelEnabled.
	if err := ipn.CheckFunnelAccess(uint16(port), st.Self); err != nil {
		return nil, err
	}

	lc := s.localClient

	// May not have funnel enabled. Enable it.
	srvConfig, err := lc.GetServeConfig(ctx)
	if err != nil {
		return nil, err
	}
	if srvConfig == nil {
		srvConfig = &ipn.ServeConfig{}
	}
	if len(st.CertDomains) == 0 {
		return nil, errors.New("Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https")
	}
	domain := st.CertDomains[0]
	hp := ipn.HostPort(domain + ":" + portStr)
	var cleanupOnClose func() error
	if !srvConfig.AllowFunnel[hp] {
		mak.Set(&srvConfig.AllowFunnel, hp, true)
		srvConfig.AllowFunnel[hp] = true
		if err := lc.SetServeConfig(ctx, srvConfig); err != nil {
			return nil, err
		}
		cleanupOnClose = func() error {
			sc, err := lc.GetServeConfig(ctx)
			if err != nil {
				return fmt.Errorf("cleaning config changes: %w", err)
			}
			if sc.AllowFunnel != nil {
				delete(sc.AllowFunnel, hp)
			}
			if err := lc.SetServeConfig(ctx, sc); err != nil {
				return fmt.Errorf("cleaning config changes: %w", err)
			}
			return nil
		}
	}

	// Start a funnel listener.
	ln, err := s.listen(network, addr, lnOn)
	if err != nil {
		return nil, err
	}
	ln = &cleanupListener{Listener: ln, cleanup: cleanupOnClose}
	return tls.NewListener(ln, tlsConfig), nil
}
