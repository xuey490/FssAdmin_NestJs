/**
 * useConfirm - 确认弹窗工具
 *
 * 封装 ElMessageBox.confirm，提供删除确认等常用场景的便捷方法。
 *
 * @module useConfirm
 */
import { ElMessageBox } from 'element-plus'

/**
 * 删除确认弹窗
 * @param message 确认提示信息
 */
export async function confirmDelete(message: string = '确定删除吗？'): Promise<void> {
  await ElMessageBox.confirm(message, '警告', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  })
}

/**
 * 批量删除确认弹窗
 * @param count 选中数量
 */
export async function confirmBatchDelete(count: number): Promise<void> {
  await ElMessageBox.confirm(`确认删除选中的 ${count} 条数据吗？`, '批量删除', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  })
}
