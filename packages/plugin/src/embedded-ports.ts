/**
 * 内嵌节点上的监听端口。
 *
 * 这些端口由插件自己的 tsnet 节点在用户态网络里监听，不向系统申请套接字，
 * 与宿主机上谁占用了什么端口无关，因此按最省心的默认值固定，不交给用户配置。
 */

/** 中继对外端口：http 默认端口，对外地址不必写端口。 */
export const TAILNET_LISTEN_PORT = 80

/** SSH 直连端口：DSH Go 里「添加 SSH 主机」的默认端口。 */
export const SSH_LISTEN_PORT = 22
