/**
 * useTableSelection - 表格行选择管理
 *
 * 封装表格多选行的状态管理，包括选中 ID、删除 loading 等。
 *
 * @module useTableSelection
 */
import { ref, computed } from 'vue'

export function useTableSelection<T extends { id?: number }>() {
  const selectedRows = ref<T[]>([])
  const batchDeleting = ref(false)

  const selectedIds = computed(() =>
    selectedRows.value
      .map((r) => r.id)
      .filter((id): id is number => typeof id === 'number')
  )

  const onTableSelectionChange = (rows: T[]) => {
    selectedRows.value = rows
  }

  const clearSelection = () => {
    selectedRows.value = []
  }

  return {
    selectedRows,
    selectedIds,
    batchDeleting,
    onTableSelectionChange,
    clearSelection
  }
}
