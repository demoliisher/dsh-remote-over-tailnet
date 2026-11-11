// 用一个契约覆盖多组变体，避免为每一行都注册一个测试。
// Vitest 仍然负责首次准备与最终清理；行与行之间恢复同样的夹具，
// 让计时器、mock、凭据与连接状态保持隔离。
export async function runScenarios(scenarios, between) {
  const failures = []
  for (const [index, scenario] of scenarios.entries()) {
    if (index > 0) await between?.()
    try {
      await scenario.run()
    } catch (error) {
      failures.push({ name: scenario.name, error })
    }
  }
  if (failures.length === 0) return

  // 保留首个断言的实际值与期望值以及调用栈供 Vitest 展示差异，
  // 同时列出所有失败行，不因第一行失败就停下。
  const first = failures[0].error
  const error = first instanceof Error ? first : new Error(String(first))
  error.message = failures.map(failure =>
    `${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
  ).join('\n\n')
  throw error
}

export function scenarioName(template, row, index) {
  const values = Array.isArray(row) ? [...row] : [row]
  const title = template.replace(/%[sidjf]/g, () => String(values.shift()))
    .replace(/\$([\w]+)/g, (match, key) => row?.[key] === undefined ? match : String(row[key]))
  return `${title} [row ${index + 1}]`
}
