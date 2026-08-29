import request from '@/utils/http'

const API_PATH = '/api/task/workflow/definition'

export interface WorkflowPageQuery {
  page_no?: number
  page_size?: number
  name?: string
  code?: string
  status?: number
  [key: string]: unknown
}

export interface WorkflowTable {
  id?: number
  name: string
  code: string
  description?: string
  status?: number
  nodes?: any[]
  edges?: any[]
  created_by?: number
  updated_by?: number
  created_time?: string
  updated_time?: string
  tenant_id?: number
}

export interface WorkflowForm {
  id?: number
  name?: string
  code?: string
  description?: string
  status?: number
  nodes?: any[]
  edges?: any[]
  [key: string]: unknown
}

export interface WorkflowPageResult {
  page_no?: number
  page_size?: number
  total: number
  has_next?: boolean
  items: WorkflowTable[]
}

export interface WorkflowDetailResult {
  id: number
  name: string
  code: string
  description?: string
  status?: number
  nodes?: any[]
  edges?: any[]
}

export interface WorkflowExecuteParams {
  workflow_id: number
  variables?: Record<string, any>
}

export interface WorkflowExecuteResult {
  status: number
  message?: string
}

const WorkflowDefinitionAPI = {
  getWorkflowList(query: WorkflowPageQuery) {
    return request.get<WorkflowPageResult>({ url: `${API_PATH}/list`, params: query })
  },

  getWorkflowDetail(id: number) {
    return request.get<WorkflowDetailResult>({ url: `${API_PATH}/detail/${id}` })
  },

  createWorkflow(body: WorkflowForm) {
    return request.post<WorkflowTable>({ url: `${API_PATH}/create`, data: body })
  },

  updateWorkflow(id: number, body: WorkflowForm) {
    return request.put<WorkflowTable>({ url: `${API_PATH}/update/${id}`, data: body })
  },

  deleteWorkflow(ids: number[]) {
    return request.del<void>({ url: `${API_PATH}/delete`, data: ids })
  },

  publishWorkflow(id: number, body: Record<string, any>) {
    return request.post<void>({ url: `${API_PATH}/publish/${id}`, data: body })
  },

  executeWorkflow(params: WorkflowExecuteParams) {
    return request.post<WorkflowExecuteResult>({ url: `${API_PATH}/execute`, data: params })
  }
}

export default WorkflowDefinitionAPI
