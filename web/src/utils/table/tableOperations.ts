/**
 * 表格操作列渲染：用 ArtButtonTable + ElDropdown 代替原 FaButtonTable / FaButtonMore。
 */
import { h, type VNode } from 'vue'
import { ElDropdown, ElDropdownItem, ElDropdownMenu, ElTooltip } from 'element-plus'
import ArtButtonTable from '@/components/core/forms/art-button-table/index.vue'

export const DEFAULT_MAX_INLINE_TABLE_OPERATIONS = 3

const MOBILE_BREAKPOINT = 768

export interface TableOperationAction {
  key: string | number
  label: string
  artType: 'add' | 'edit' | 'delete' | 'view' | 'more'
  icon?: string
  perm?: string
  disabled?: boolean
  iconColor?: string
  color?: string
  run: () => void
}

export interface RenderTableOperationCellOptions {
  maxInline?: number
  wrapperClass?: string
  emptyText?: string
}

const ART_TYPE_DEFAULT_ICONS: Record<TableOperationAction['artType'], string> = {
  add: 'ri:add-fill',
  edit: 'ri:pencil-line',
  delete: 'ri:delete-bin-5-line',
  view: 'ri:eye-line',
  more: 'ri:more-2-fill'
}

const ART_TYPE_ICON_COLORS: Record<TableOperationAction['artType'], string> = {
  add: 'var(--el-color-primary)',
  edit: 'var(--el-color-success)',
  delete: 'var(--el-color-danger)',
  view: 'var(--el-color-info)',
  more: 'var(--el-text-color-regular)'
}

function iconForOperation(a: TableOperationAction): string {
  return a.icon ?? ART_TYPE_DEFAULT_ICONS[a.artType]
}

function iconColorForOperation(a: TableOperationAction): string | undefined {
  if (a.iconColor != null) return a.iconColor
  return ART_TYPE_ICON_COLORS[a.artType]
}

export function renderTableOperationCell(
  actions: TableOperationAction[],
  options?: RenderTableOperationCellOptions
): VNode {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
  const maxInline = isMobile ? 0 : (options?.maxInline ?? DEFAULT_MAX_INLINE_TABLE_OPERATIONS)
  const wrapperClass =
    options?.wrapperClass ?? 'inline-flex flex-wrap items-center justify-end gap-1'
  const emptyText = options?.emptyText ?? '—'

  if (actions.length === 0) return h('span', { class: 'text-g-400' }, emptyText)

  const inline = actions.slice(0, maxInline)
  const overflow = actions.slice(maxInline)

  const inlineNodes = inline.map((a) =>
    h(ElTooltip, { content: a.label, placement: 'top' }, () =>
      h(
        'span',
        { class: a.disabled ? 'inline-flex opacity-40 pointer-events-none' : 'inline-flex' },
        [
          h(ArtButtonTable, {
            type: a.artType,
            icon: iconForOperation(a),
            iconColor: iconColorForOperation(a),
            onClick: a.run
          })
        ]
      )
    )
  )

  if (overflow.length === 0) return h('div', { class: wrapperClass }, inlineNodes)

  const moreDropdown = h(
    ElDropdown,
    {
      trigger: 'click',
      onCommand: (key: string | number) => {
        const act = overflow.find((x) => String(x.key) === String(key))
        act?.run()
      }
    },
    {
      default: () =>
        h(ArtButtonTable, {
          type: 'more',
          icon: 'ri:more-2-fill'
        }),
      dropdown: () =>
        h(ElDropdownMenu, null, () =>
          overflow.map((a) =>
            h(
              ElDropdownItem,
              {
                command: a.key,
                disabled: a.disabled,
                style: a.color || String(a.key) === 'delete' ? { color: a.color || 'var(--el-color-danger)' } : undefined
              },
              () => a.label
            )
          )
        )
    }
  )

  return h('div', { class: wrapperClass }, [...inlineNodes, moreDropdown])
}
