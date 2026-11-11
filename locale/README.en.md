# DSH Remote over Tailscale

Connect to a running DeepSeek Harness session on your computer from your phone over Tailscale, including streaming output, without a public gateway.

## Features

- Reuses the Tailscale client already installed on the computer; no public IP, port forwarding, or third-party relay.
- Starts a local relay on a loopback address and idempotently publishes it through `tailscale serve` over HTTPS.
- Shows the DSH Go server address, account, and password in the plugin panel, with status for Tailscale, relay, HTTPS address, and host authorization.
- Connects to the already-running DSH Desktop session with streaming output; dsh-go is not modified.

## Get started

1. Install and enable the plugin in DSH Desktop, then restart Desktop.
2. Open Plugins → DSH Remote over Tailscale → Remote settings and wait for the four steps to complete.
3. Add a custom server in dsh-go with the HTTPS address and credentials shown in the panel.

Requirements: phone and computer on the same tailnet, Tailscale signed in on the computer, and HTTPS Certificates enabled for the tailnet.

This is a fork of the MIT project ds-harness-remote and is not affiliated with Tailscale Inc. or DeepSeek.
