import { describe, expect, it } from 'vitest'
import { TAILNET_LISTEN_PORT, publicUrlFor, tailnetRelayPort } from '../src/tailnet/orchestrator.js'

// 回归：对外地址曾经随中继端口写成 http://名字:8080；节点改在 tailnet 的 80 端口监听后，
// 地址必须保持无端口形式，否则客户端会连到中继端口而不是节点监听端口。
describe('tailnet 对外地址', () => {
  it('去掉 DNSName 末尾的点并且不写端口', () => {
    expect(publicUrlFor('dsh-remote.tail81eea4.ts.net.')).toBe('http://dsh-remote.tail81eea4.ts.net')
  })

  it('tailnet 监听端口是 http 默认端口', () => {
    expect(TAILNET_LISTEN_PORT).toBe(80)
  })
})

// 只有 http + 回环地址才由插件起中继；https 与局域网地址都按外部服务器处理。
describe('tailnetRelayPort', () => {
  it('识别回环 http 地址的端口', () => {
    expect(tailnetRelayPort('http://127.0.0.1:8080')).toBe(8080)
    expect(tailnetRelayPort('http://localhost:9000')).toBe(9000)
  })

  it('外部服务器地址返回 undefined', () => {
    expect(tailnetRelayPort('https://127.0.0.1:8080')).toBeUndefined()
    expect(tailnetRelayPort('http://10.0.0.5:8080')).toBeUndefined()
    expect(tailnetRelayPort('http://127.0.0.1')).toBeUndefined()
    expect(tailnetRelayPort(undefined)).toBeUndefined()
  })
})
