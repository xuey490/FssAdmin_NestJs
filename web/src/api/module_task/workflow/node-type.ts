import request from '@/utils/http'

const API_PATH = '/api/task/workflow/node-type'

export interface WorkflowNodeTypePageQuery {
  page_no?: number
  page_size?: number
  name?: string
  code?: string
  category?: string
  status?: number
  [key: string]: unknown
}

export interface WorkflowNodeTypeTable {
  id?: number
  name: string
  code: string
  category?: string
  func?: string
  args?: string
  kwargs?: string
  sort_order?: number
  is_active?: boolean
  created_time?: string
  updated_time?: string
  tenant_id?: number
}

export interface WorkflowNodeTypeForm {
  id?: number
  name: string
  code: string
  category: string
  func?: string
  args?: string
  kwargs?: string
  sort_order?: number
  is_active?: boolean
}

export interface WorkflowNodeTypeOption {
  id: number
  name: string
  code: string
  category?: string
  func?: string
  args?: string
  kwargs?: string
}

export interface WorkflowNodeTypePageResult {
  page_no?: number
  page_size?: number
  total: number
  has_next?: boolean
  items: WorkflowNodeTypeTable[]
}

const WorkflowNodeTypeAPI = {
  getWorkflowNodeTypeList(query: WorkflowNodeTypePageQuery) {
    return request.get<WorkflowNodeTypePageResult>({ url: `${API_PATH}/list`, params: query })
  },

  getWorkflowNodeTypeOptions() {
    return request.get<WorkflowNodeTypeOption[]>({ url: `${API_PATH}/options` })
  },

  getWorkflowNodeTypeDetail(id: number) {
    return request.get<WorkflowNodeTypeTable>({ url: `${API_PATH}/detail/${id}` })
  },

  createWorkflowNodeType(body: WorkflowNodeTypeForm) {
    return request.post<WorkflowNodeTypeTable>({ url: `${API_PATH}/create`, data: body })
  },

  updateWorkflowNodeType(id: number, body: WorkflowNodeTypeForm) {
    return request.put<WorkflowNodeTypeTable>({ url: `${API_PATH}/update/${id}`, data: body })
  },

  deleteWorkflowNodeType(ids: number[]) {
    return request.del<void>({ url: `${API_PATH}/delete`, data: ids })
  }
}

export default WorkflowNodeTypeAPI
