import type { Component } from 'vue'

/**
 * 搜索栏表单项配置类型
 * 从 art-search-bar 组件中提取，供外部 .vue 文件引用
 */
export interface SearchFormItem {
  /** 表单项的唯一标识 */
  key: string
  /** 表单项的标签文本或自定义渲染函数 */
  label: string | (() => VNode) | Component
  /** 表单项标签的宽度，会覆盖 Form 的 labelWidth */
  labelWidth?: string | number
  /** 表单项类型，支持预定义的组件类型 */
  type?: string
  /** 自定义渲染函数或组件，用于渲染自定义组件（优先级高于 type） */
  render?: (() => VNode) | Component
  /** 是否隐藏该表单项 */
  hidden?: boolean
  /** 表单项占据的列宽，基于24格栅格系统 */
  span?: number
  /** 选项数据，用于 select、checkbox-group、radio-group 等 */
  options?: Record<string, any>
  /** 传递给表单项组件的属性 */
  props?: Record<string, any>
  /** 表单项的插槽配置 */
  slots?: Record<string, (() => any) | undefined>
  /** 表单项的占位符文本 */
  placeholder?: string
}
