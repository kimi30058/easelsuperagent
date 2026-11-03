// @vitest-environment jsdom
// The shared page chrome: the header band, the stat tiles, and the empty state.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'
import { EmptyState, PageHeader, StatRow, StatTile } from '../src/client/widgets.tsx'

let root: Root | undefined
const render = async (node: ReactNode): Promise<void> => {
  document.body.innerHTML = ''
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(node) })
}

it('renders the header band with title, hint, and actions', async () => {
  await render(<PageHeader title="执行" hint="执行器的状态" actions={<button type="button">暂停</button>} />)
  expect(document.querySelector('.dt-header-title')?.textContent).toBe('执行')
  expect(document.querySelector('.dt-header-hint')?.textContent).toBe('执行器的状态')
  expect(document.querySelector('.dt-header-actions button')?.textContent).toBe('暂停')
})

it('renders stat tiles as divs, clickable ones as buttons', async () => {
  await render(<StatRow>
    <StatTile value="2 / 4" label="执行中" />
    <StatTile value={3} label="排队" onClick={() => undefined} />
  </StatRow>)
  expect(document.querySelectorAll('.dt-stat-tile')).toHaveLength(2)
  expect(document.querySelector('.dt-stat-tile-value')?.textContent).toBe('2 / 4')
  expect(document.querySelector('.dt-stat-tile-label')?.textContent).toBe('执行中')
  expect(document.querySelectorAll('button.dt-stat-tile')).toHaveLength(1)
})

it('renders the empty state with its guidance action', async () => {
  await render(<EmptyState icon="queue" title="还没有工单" hint="发一条请求开始" action={<button type="button">去消息页</button>} />)
  expect(document.querySelector('.dt-empty-title')?.textContent).toBe('还没有工单')
  expect(document.querySelector('.dt-empty-hint')?.textContent).toBe('发一条请求开始')
  expect(document.querySelector('.dt-empty-action button')?.textContent).toBe('去消息页')
})
