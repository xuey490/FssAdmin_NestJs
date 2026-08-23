import request from '@/utils/http'

const API_PATH = '/api/task/cronjob/node'

export interface NodePageQuery {
  page_no?: number
  page_size?: number
  name?: string
  code?: string
  status?: number
  [key: string]: unknown
}

export type TriggerType = 'now' | 'cron' | 'interval' | 'date'

export interface ExecuteNodeParams {
  trigger: TriggerType
  trigger_args?: string
  start_date?: string
  end_date?: string
}

export interface ExecuteNodeResult {
  job_id: number
  status: number
  trigger: TriggerType
}

export interface NodeTable {
  id?: number
  name: string
  code: string
  jobstore?: string
  executor?: string
  trigger?: TriggerType | string
  trigger_args?: string
  func?: string
  args?: string
  kwargs?: string
  coalesce?: boolean
  max_instances?: number
  start_date?: string
  end_date?: string
  created_by?: number
  updated_by?: number
  status?: number
  description?: string
  created_time?: string
  updated_time?: string
  tenant_id?: number
}

export interface NodeForm {
  id?: number
  name: string
  code?: string
  jobstore?: string
  executor?: string
  func?: string
  args?: string
  kwargs?: string
  coalesce?: boolean
  max_instances?: number
  start_date?: string
  end_date?: string
  status?: number
  description?: string
}

export interface NodeType {
  id: number
  name: string
  code: string
  func?: string
  args?: string
  kwargs?: string
}

export interface NodeBatchStatus {
  ids: number[]
  status: number
}

/** 与后端 PageResultSchema 对齐 */
export interface NodePageResult {
  page_no?: number
  page_size?: number
  total: number
  has_next?: boolean
  items: NodeTable[]
}

const NodeAPI = {
  getNodeTypeOptions() {
    return request.get<NodeType[]>({ url: `${API_PATH}/options` })
  },

  listNode(query: NodePageQuery) {
    return request.get<NodePageResult>({ url: `${API_PATH}/list`, params: query })
  },

  detailNode(id: number) {
    return request.get<NodeTable>({ url: `${API_PATH}/detail/${id}` })
  },

  createNode(body: NodeForm) {
    return request.post<NodeTable>({ url: `${API_PATH}/create`, data: body })
  },

  updateNode(id: number, body: NodeForm) {
    return request.put<NodeTable>({ url: `${API_PATH}/update/${id}`, data: body })
  },

  deleteNode(ids: number[]) {
    return request.del<void>({ url: `${API_PATH}/delete`, data: ids })
  },

  clearNode() {
    return request.del<void>({ url: `${API_PATH}/clear` })
  },

  batchNode(body: NodeBatchStatus) {
    return request.request<void>({ url: `${API_PATH}/status/batch`, method: 'PATCH', data: body })
  },

  executeNode(id: number, params: ExecuteNodeParams = { trigger: 'now' }) {
    return request.post<ExecuteNodeResult>({ url: `${API_PATH}/execute/${id}`, data: params })
  },

  /** 节点执行日志（task_job，job_id = 节点 id） */
  listNodeLogs(
    id: number,
    query: {
      page_no?: number
      page_size?: number
      status?: number
      trigger_type?: string
      [key: string]: unknown
    }
  ) {
    return request.get<{
      page_no?: number
      page_size?: number
      total: number
      has_next?: boolean
      items: Array<{
        id?: number
        job_id: string
        job_name?: string
        trigger_type?: string
        next_run_time?: string
        job_state?: string
        result?: string
        error?: string
        status?: number
        created_time?: string
      }>
    }>({ url: `${API_PATH}/logs/${id}`, params: query })
  }
}

export default NodeAPI
