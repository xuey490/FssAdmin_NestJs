<!-- 定时任务节点：SaSearchBar + ArtTable + ElDialog（无 Fa*） -->
<template>
  <div class="art-full-height">
    <ArtPageReady variant="table">
      <SaSearchBar
        v-show="showSearchBar"
        v-model="searchForm"
        label-width="80px"
        :show-expand="false"
        @search="handleSearch"
        @reset="onResetSearch"
      >
        <ElCol :xs="24" :sm="12" :md="6">
          <ElFormItem label="节点名称" prop="name">
            <ElInput v-model="searchForm.name" placeholder="请输入节点名称" clearable />
          </ElFormItem>
        </ElCol>
        <ElCol :xs="24" :sm="12" :md="6">
          <ElFormItem label="节点编码" prop="code">
            <ElInput v-model="searchForm.code" placeholder="请输入节点编码" clearable />
          </ElFormItem>
        </ElCol>
        <ElCol :xs="24" :sm="12" :md="6">
          <ElFormItem label="状态" prop="status">
            <ElSelect v-model="searchForm.status" placeholder="请选择状态" clearable class="w-full">
              <ElOption label="启用" :value="0" />
              <ElOption label="停用" :value="1" />
            </ElSelect>
          </ElFormItem>
        </ElCol>
      </SaSearchBar>

      <ElCard
        class="art-table-card"
        shadow="never"
        :style="{ 'margin-top': showSearchBar ? '12px' : '0' }"
      >
        <ArtTableHeader
          v-model:columns="columnChecks"
          v-model:showSearchBar="showSearchBar"
          :loading="loading"
          @refresh="refreshData"
        >
          <template #left>
            <ElSpace wrap>
              <ElButton
                v-permission="'module_task:cronjob:node:create'"
                type="primary"
                :loading="createLoading"
                @click="handleAdd"
              >
                <template #icon><ArtSvgIcon icon="ri:add-fill" /></template>
                新增
              </ElButton>
              <ElButton
                v-permission="'module_task:cronjob:node:delete'"
                type="danger"
                plain
                :disabled="selectedIds.length === 0"
                :loading="batchDeleting"
                @click="handleBatchDelete"
              >
                批量删除
              </ElButton>
            </ElSpace>
          </template>
        </ArtTableHeader>

        <ArtTable
          ref="tableRef"
          row-key="id"
          :loading="loading"
          :data="data"
          :columns="columns"
          :pagination="pagination"
          @selection-change="onTableSelectionChange"
          @pagination:size-change="handleSizeChange"
          @pagination:current-change="handleCurrentChange"
        >
          <template #operation="{ row }">
            <div class="flex gap-1 justify-end">
              <SaButton
                v-permission="'module_task:cronjob:node:query'"
                type="info"
                icon="ri:file-list-3-line"
                tool-tip="执行日志"
                @click="handleOpenLogDrawer(row)"
              />
              <SaButton
                v-permission="'module_task:cronjob:node:execute'"
                type="primary"
                icon="ri:play-circle-line"
                tool-tip="调试"
                @click="handleOpenExecuteDialog(row)"
              />
              <SaButton
                v-permission="'module_task:cronjob:node:update'"
                type="secondary"
                tool-tip="编辑"
                @click="handleOpenDialog('update', row.id)"
              />
              <SaButton
                v-permission="'module_task:cronjob:node:delete'"
                type="error"
                tool-tip="删除"
                @click="deleteNodeRow(row.id)"
              />
            </div>
          </template>
        </ArtTable>
      </ElCard>
    </ArtPageReady>

    <!-- 新增/编辑 -->
    <ElDialog
      v-model="dialogVisible.visible"
      :title="dialogVisible.title"
      width="1000px"
      destroy-on-close
      append-to-body
      @closed="handleCloseDialog"
      @opened="handleDialogOpened"
    >
      <ElRow :gutter="16">
        <ElCol :span="10">
          <ElForm
            ref="dataFormRef"
            :model="formData"
            :rules="rules"
            label-width="90px"
            label-suffix=":"
          >
            <ElFormItem label="节点名称" prop="name">
              <ElInput v-model="formData.name" maxlength="64" placeholder="请输入节点名称" />
            </ElFormItem>
            <ElFormItem label="节点编码" prop="code">
              <ElInput v-model="formData.code" maxlength="32" placeholder="请输入节点编码" />
            </ElFormItem>
            <ElFormItem label="存储器" prop="jobstore">
              <ElSelect v-model="formData.jobstore" placeholder="请选择存储器" class="w-full">
                <ElOption
                  v-for="item in jobStoreOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </ElSelect>
            </ElFormItem>
            <ElFormItem label="执行器" prop="executor">
              <ElSelect v-model="formData.executor" placeholder="请选择执行器" class="w-full">
                <ElOption
                  v-for="item in executorOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </ElSelect>
            </ElFormItem>
            <ElFormItem label="合并运行" prop="coalesce">
              <ElSwitch v-model="formData.coalesce" />
            </ElFormItem>
            <ElFormItem label="最大实例数" prop="max_instances">
              <ElInputNumber
                v-model="formData.max_instances"
                :min="1"
                :max="10"
                controls-position="right"
              />
            </ElFormItem>
            <ElFormItem label="位置参数">
              <div class="dynamic-params">
                <div v-for="(_item, index) in argsList" :key="index" class="param-item">
                  <ElInput v-model="argsList[index]" placeholder="参数值" />
                  <ElButton type="danger" link @click="argsList.splice(index, 1)">删除</ElButton>
                </div>
                <ElButton type="primary" link @click="argsList.push('')">添加参数</ElButton>
              </div>
            </ElFormItem>
            <ElFormItem label="关键字参数">
              <div class="dynamic-params">
                <div v-for="(item, index) in kwargsList" :key="index" class="param-item">
                  <ElInput v-model="item.key" placeholder="key" class="param-key" />
                  <ElInput v-model="item.value" placeholder="value" />
                  <ElButton type="danger" link @click="kwargsList.splice(index, 1)">删除</ElButton>
                </div>
                <ElButton type="primary" link @click="kwargsList.push({ key: '', value: '' })">
                  添加参数
                </ElButton>
              </div>
            </ElFormItem>
          </ElForm>
        </ElCol>
        <ElCol :span="14">
          <div class="code-label">代码块 (func)</div>
          <Codemirror
            ref="codeEditorRef"
            v-model:value="formData.func"
            :options="codeEditorOptions"
            border
            height="420"
            width="100%"
          />
        </ElCol>
      </ElRow>
      <template #footer>
        <ElButton @click="dialogVisible.visible = false">取消</ElButton>
        <ElButton type="primary" :loading="submitLoading" @click="handleSubmit">确定</ElButton>
      </template>
    </ElDialog>

    <!-- 调试 -->
    <ElDialog
      v-model="executeDialogVisible"
      title="调试节点"
      width="700px"
      destroy-on-close
      append-to-body
      @closed="handleCloseExecuteDialog"
    >
      <ElForm
        ref="executeFormRef"
        :model="executeFormData"
        :rules="executeRules"
        label-width="90px"
        label-suffix=":"
      >
        <ElFormItem label="节点名称">
          <ElInput v-model="executeFormData.node_display_name" disabled />
        </ElFormItem>
        <ElFormItem label="执行方式" prop="trigger">
          <ElRadioGroup v-model="executeFormData.trigger">
            <ElRadio value="now">立即执行</ElRadio>
            <ElRadio value="cron">Cron表达式</ElRadio>
            <ElRadio value="interval">时间间隔</ElRadio>
            <ElRadio value="date">固定日期</ElRadio>
          </ElRadioGroup>
        </ElFormItem>
        <ElFormItem
          v-if="executeFormData.trigger !== 'now'"
          :label="triggerArgsLabel"
          prop="trigger_args"
        >
          <template v-if="executeFormData.trigger === 'cron'">
            <ElPopover
              :visible="openCron"
              width="700px"
              trigger="click"
              :persistent="false"
              placement="bottom"
              popper-class="node-cron-popover-fix"
            >
              <template #reference>
                <ElInput
                  v-model="executeFormData.trigger_args"
                  placeholder="请输入 * * * * * ? *"
                  @click="openCron = true"
                />
              </template>
              <vue3CronPlus i18n="cn" @change="handlechangeCron" @close="openCron = false" />
            </ElPopover>
          </template>
          <template v-else-if="executeFormData.trigger === 'interval'">
            <ElPopover
              :visible="openInterval"
              width="360px"
              trigger="click"
              :persistent="false"
              placement="bottom"
            >
              <template #reference>
                <ElInput
                  v-model="executeFormData.trigger_args"
                  placeholder="格式：秒 分 时 天 周，点击设置"
                  @click="openInterval = true"
                />
              </template>
              <IntervalTab
                :cron-value="executeFormData.trigger_args"
                @confirm="handleIntervalConfirm"
                @cancel="openInterval = false"
              />
            </ElPopover>
          </template>
          <template v-else-if="executeFormData.trigger === 'date'">
            <ElDatePicker
              v-model="executeFormData.trigger_args"
              type="datetime"
              format="YYYY-MM-DD HH:mm:ss"
              value-format="YYYY-MM-DD HH:mm:ss"
              placeholder="请选择执行时间"
              class="w-full"
            />
          </template>
        </ElFormItem>
        <ElFormItem
          v-if="executeFormData.trigger === 'cron' || executeFormData.trigger === 'interval'"
          label="开始时间"
        >
          <ElDatePicker
            v-model="executeFormData.start_date"
            type="datetime"
            format="YYYY-MM-DD HH:mm:ss"
            value-format="YYYY-MM-DD HH:mm:ss"
            placeholder="可选"
            class="w-full"
          />
        </ElFormItem>
        <ElFormItem
          v-if="executeFormData.trigger === 'cron' || executeFormData.trigger === 'interval'"
          label="结束时间"
        >
          <ElDatePicker
            v-model="executeFormData.end_date"
            type="datetime"
            format="YYYY-MM-DD HH:mm:ss"
            value-format="YYYY-MM-DD HH:mm:ss"
            placeholder="可选"
            class="w-full"
          />
        </ElFormItem>
      </ElForm>
      <template #footer>
        <ElButton @click="handleCloseExecuteDialog">取消</ElButton>
        <ElButton type="primary" :loading="submitLoading" @click="handleExecuteNode">确认</ElButton>
      </template>
    </ElDialog>

    <ElDrawer
      v-model="logDrawerVisible"
      :title="logDrawerTitle"
      direction="rtl"
      size="80%"
      append-to-body
    >
      <div class="node-log-drawer">
        <SaSearchBar
          v-model="logSearchForm"
          label-width="80px"
          :show-expand="false"
          @search="handleLogSearch"
          @reset="onLogResetSearch"
        >
          <ElCol :xs="24" :sm="12" :md="8">
            <ElFormItem label="执行状态" prop="status">
              <ElSelect
                v-model="logSearchForm.status"
                placeholder="请选择状态"
                clearable
                class="w-full"
              >
                <ElOption label="待执行" :value="0" />
                <ElOption label="执行中" :value="1" />
                <ElOption label="成功" :value="2" />
                <ElOption label="失败" :value="3" />
                <ElOption label="超时" :value="4" />
                <ElOption label="已取消" :value="5" />
              </ElSelect>
            </ElFormItem>
          </ElCol>
          <ElCol :xs="24" :sm="12" :md="8">
            <ElFormItem label="触发方式" prop="trigger_type">
              <ElSelect
                v-model="logSearchForm.trigger_type"
                placeholder="请选择"
                clearable
                class="w-full"
              >
                <ElOption label="Cron表达式" value="cron" />
                <ElOption label="时间间隔" value="interval" />
                <ElOption label="固定日期" value="date" />
                <ElOption label="一次性任务" value="manual" />
              </ElSelect>
            </ElFormItem>
          </ElCol>
        </SaSearchBar>

        <ElCard class="art-table-card node-log-table-card mt-3" shadow="never">
          <ArtTableHeader
            v-model:columns="logColumnChecks"
            layout="refresh"
            :loading="logLoading"
            @refresh="refreshLogData"
          />
          <ArtTable
            row-key="id"
            :loading="logLoading"
            :data="logTableData"
            :columns="logColumns"
            :pagination="logPagination"
            @pagination:size-change="logHandleSizeChange"
            @pagination:current-change="logHandleCurrentChange"
          >
            <template #trigger_type="{ row }">
              {{ logTriggerLabel(row.trigger_type) }}
            </template>
            <template #status="{ row }">
              <ElTag :type="logStatusTagType(row.status)" size="small">
                {{ logStatusLabel(row.status) }}
              </ElTag>
            </template>
            <template #job_state="{ row }">
              <ElButton
                v-if="row.job_state"
                type="primary"
                link
                size="small"
                @click="handleViewJobState(row.job_state)"
              >
                查看
              </ElButton>
              <span v-else>—</span>
            </template>
          </ArtTable>
        </ElCard>
      </div>
    </ElDrawer>

    <ElDialog
      v-model="jobStateVisible"
      title="执行元数据"
      width="800px"
      append-to-body
      destroy-on-close
    >
      <pre class="job-state-pre">{{ jobStateText }}</pre>
      <template #footer>
        <ElButton type="primary" @click="jobStateVisible = false">关闭</ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<script lang="ts" setup>
defineOptions({ name: 'Node', inheritAttrs: false })

import NodeAPI, {
  type NodeTable,
  type NodeForm,
  type TriggerType,
  type ExecuteNodeParams
} from '@/api/module_task/cronjob/node'
import IntervalTab from '@/components/others/interval-tab/index.vue'
import { useTable } from '@/hooks/core/useTable'
import type { ColumnOption } from '@/types/component'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { computed, nextTick, reactive, ref } from 'vue'
import Codemirror, { type CmComponentRef } from 'codemirror-editor-vue3'
import type { EditorConfiguration } from 'codemirror'
import 'codemirror/mode/python/python.js'
import 'codemirror/theme/dracula.css'
import { vue3CronPlus } from 'vue3-cron-plus'
import 'vue3-cron-plus/dist/index.css'

const BATCH_DELETE_NODE_MSG =
  '确认删除选中的节点吗？\n此操作将同时删除节点定义并移除调度器中的相关任务。'

type NodeSearchForm = {
  name?: string
  code?: string
  status?: number
}

const searchForm = ref<NodeSearchForm>({
  name: undefined,
  code: undefined,
  status: undefined
})
const showSearchBar = ref(true)
const tableRef = ref<{ elTableRef?: { clearSelection: () => void } } | null>(null)
const selectedRows = ref<NodeTable[]>([])
const selectedIds = computed(() =>
  selectedRows.value.map((r) => r.id).filter((id): id is number => typeof id === 'number')
)
const batchDeleting = ref(false)
const createLoading = ref(false)
const submitLoading = ref(false)

function onTableSelectionChange(rows: NodeTable[]) {
  selectedRows.value = rows
}

const {
  columns,
  columnChecks,
  data,
  loading,
  pagination,
  getData,
  replaceSearchParams,
  resetSearchParams,
  handleSizeChange,
  handleCurrentChange,
  refreshData,
  refreshCreate,
  refreshUpdate,
  refreshRemove
} = useTable({
  core: {
    apiFn: NodeAPI.listNode,
    apiParams: { page_no: 1, page_size: 10 },
    paginationKey: { current: 'page_no', size: 'page_size' },
    columnsFactory: (): ColumnOption<NodeTable>[] => [
      { type: 'selection', width: 48, fixed: 'left' },
      { type: 'globalIndex', width: 56, label: '序号' },
      { prop: 'name', label: '节点名称', minWidth: 140, showOverflowTooltip: true },
      { prop: 'code', label: '节点编码', minWidth: 120, showOverflowTooltip: true },
      { prop: 'jobstore', label: '存储器', minWidth: 90 },
      { prop: 'executor', label: '执行器', minWidth: 90 },
      { prop: 'created_time', label: '创建时间', minWidth: 170, showOverflowTooltip: true },
      {
        prop: 'operation',
        label: '操作',
        width: 180,
        fixed: 'right',
        align: 'center',
        useSlot: true
      }
    ]
  }
})

function handleSearch() {
  replaceSearchParams({
    name: searchForm.value.name,
    code: searchForm.value.code,
    status: searchForm.value.status
  })
  getData()
}

async function onResetSearch() {
  searchForm.value = { name: undefined, code: undefined, status: undefined }
  await resetSearchParams()
}

async function deleteNodeRow(id: number | undefined) {
  if (id == null) return
  try {
    await ElMessageBox.confirm(BATCH_DELETE_NODE_MSG, '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await NodeAPI.deleteNode([id])
    tableRef.value?.elTableRef?.clearSelection()
    await refreshRemove()
  } catch {
    // cancel
  }
}

async function handleBatchDelete() {
  const ids = selectedIds.value
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(BATCH_DELETE_NODE_MSG, '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    batchDeleting.value = true
    await NodeAPI.deleteNode(ids)
    selectedRows.value = []
    await refreshRemove()
  } catch {
    // cancel
  } finally {
    batchDeleting.value = false
  }
}

/** 与 ap_scheduler jobstores / executors 别名对齐 */
const jobStoreOptions = [
  { label: '默认(Redis)', value: 'default' },
  { label: '内存(Memory)', value: 'memory' },
  { label: '数据库(Sqlalchemy)', value: 'sqlalchemy' }
]

const executorOptions = [
  { label: '线程池(default)', value: 'default' },
  { label: '进程池(processpool)', value: 'processpool' }
]

const defaultCodeBlock = `def handler(*args, **kwargs):
    from app.plugin.module_task.cronjob.node.handlers.demo_handler import (
        demo_handler,
        process_data
    )
    result1 = demo_handler("参数1", "参数2", key="value")
    numbers = [10, 20, 30, 40, 50]
    result2 = process_data(numbers, operation="avg")
    result3 = process_data(numbers, operation="sum")
    return {
        "status": "success",
        "demo_result": result1,
        "avg_result": result2,
        "sum_result": result3
    }
`

const formData = ref<NodeForm>({
  id: undefined,
  name: '',
  code: undefined,
  jobstore: 'default',
  executor: 'default',
  func: defaultCodeBlock,
  args: undefined,
  kwargs: undefined,
  coalesce: false,
  max_instances: 1
})

const argsList = ref<string[]>([])
const kwargsList = ref<{ key: string; value: string }[]>([])
const dataFormRef = ref<FormInstance>()
const codeEditorRef = ref<CmComponentRef>()
const dialogVisible = reactive({
  title: '',
  visible: false,
  type: 'create' as 'create' | 'update'
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入节点名称', trigger: 'blur' }],
  code: [{ required: true, message: '请输入节点编码', trigger: 'blur' }]
}

const codeEditorOptions: EditorConfiguration = {
  mode: 'python',
  lineNumbers: true,
  smartIndent: true,
  indentUnit: 4,
  tabSize: 4,
  theme: 'dracula',
  lineWrapping: true,
  autofocus: false
}

function resetForm() {
  Object.assign(formData.value, {
    id: undefined,
    name: '',
    code: undefined,
    jobstore: 'default',
    executor: 'default',
    func: defaultCodeBlock,
    args: undefined,
    kwargs: undefined,
    coalesce: false,
    max_instances: 1
  })
  argsList.value = []
  kwargsList.value = []
  dataFormRef.value?.clearValidate()
}

function handleCloseDialog() {
  dialogVisible.visible = false
  resetForm()
}

async function handleAdd() {
  createLoading.value = true
  try {
    await handleOpenDialog('create')
  } finally {
    createLoading.value = false
  }
}

async function handleOpenDialog(type: 'create' | 'update', id?: number) {
  dialogVisible.type = type
  if (id) {
    const detail = await NodeAPI.detailNode(id)
    dialogVisible.title = '修改节点'
    Object.assign(formData.value, detail)
    argsList.value = detail.args ? detail.args.split(',').map((v) => v.trim()) : []
    kwargsList.value = detail.kwargs
      ? Object.entries(JSON.parse(detail.kwargs)).map(([key, value]) => ({
          key,
          value: String(value)
        }))
      : []
  } else {
    dialogVisible.title = '新增节点'
    resetForm()
  }
  dialogVisible.visible = true
}

function handleDialogOpened() {
  nextTick(() => {
    setTimeout(() => codeEditorRef.value?.refresh?.(), 100)
  })
}

async function handleSubmit() {
  const valid = await dataFormRef.value?.validate().catch(() => false)
  if (!valid) return
  if (!formData.value.func?.trim()) {
    ElMessage.warning('请填写代码块')
    return
  }
  submitLoading.value = true
  try {
    const submitData: NodeForm = {
      ...formData.value,
      args: argsList.value.filter((v) => v.trim()).join(',') || undefined,
      kwargs:
        kwargsList.value.filter((v) => v.key.trim()).length > 0
          ? JSON.stringify(
              Object.fromEntries(
                kwargsList.value.filter((v) => v.key.trim()).map((v) => [v.key, v.value])
              )
            )
          : undefined
    }
    const id = formData.value.id
    if (id) {
      await NodeAPI.updateNode(id, submitData)
      dialogVisible.visible = false
      resetForm()
      await refreshUpdate()
    } else {
      await NodeAPI.createNode(submitData)
      dialogVisible.visible = false
      resetForm()
      await refreshCreate()
    }
  } catch (e) {
    console.error(e)
  } finally {
    submitLoading.value = false
  }
}

const executeDialogVisible = ref(false)
const executeFormRef = ref<FormInstance>()
const openCron = ref(false)
const openInterval = ref(false)
const currentExecuteNode = ref<NodeTable | null>(null)
const executeFormData = ref<{
  node_display_name: string
  trigger: TriggerType
  trigger_args?: string
  start_date?: string
  end_date?: string
}>({
  node_display_name: '',
  trigger: 'now',
  trigger_args: undefined,
  start_date: undefined,
  end_date: undefined
})

const triggerArgsLabel = computed(() => {
  const t = executeFormData.value.trigger
  if (t === 'cron') return 'Cron表达式'
  if (t === 'interval') return '间隔时间'
  if (t === 'date') return '执行时间'
  return '执行参数'
})

const executeRules = computed<FormRules>(() => ({
  trigger: [{ required: true, message: '请选择执行方式', trigger: 'change' }],
  trigger_args:
    executeFormData.value.trigger === 'now'
      ? []
      : [{ required: true, message: '请设置执行参数', trigger: 'blur' }]
}))

function handlechangeCron(cronStr: string) {
  if (typeof cronStr === 'string') executeFormData.value.trigger_args = cronStr
}

function handleIntervalConfirm(value: string) {
  executeFormData.value.trigger_args = value
  openInterval.value = false
}

function handleOpenExecuteDialog(row: NodeTable) {
  currentExecuteNode.value = row
  executeFormData.value = {
    node_display_name: row.name ?? '',
    trigger: 'now',
    trigger_args: undefined,
    start_date: undefined,
    end_date: undefined
  }
  executeDialogVisible.value = true
}

function handleCloseExecuteDialog() {
  executeDialogVisible.value = false
  currentExecuteNode.value = null
  openCron.value = false
  openInterval.value = false
}

async function handleExecuteNode() {
  if (executeFormData.value.trigger !== 'now') {
    const valid = await executeFormRef.value?.validate().catch(() => false)
    if (!valid) return
  }
  const id = currentExecuteNode.value?.id
  if (id == null) return
  submitLoading.value = true
  try {
    const params: ExecuteNodeParams = { trigger: executeFormData.value.trigger }
    if (executeFormData.value.trigger !== 'now') {
      params.trigger_args = executeFormData.value.trigger_args
      params.start_date = executeFormData.value.start_date
      params.end_date = executeFormData.value.end_date
    }
    await NodeAPI.executeNode(id, params)
    ElMessage.success('已提交执行')
    handleCloseExecuteDialog()
  } catch (e) {
    console.error(e)
  } finally {
    submitLoading.value = false
  }
}

type NodeLogRow = {
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
}

const logDrawerVisible = ref(false)
const currentLogNodeId = ref<number>()
const currentLogNodeName = ref('')
const logDrawerTitle = computed(() =>
  currentLogNodeName.value ? `执行日志 — ${currentLogNodeName.value}` : '执行日志'
)
const logSearchForm = ref<{ status?: number; trigger_type?: string }>({
  status: undefined,
  trigger_type: undefined
})
const jobStateVisible = ref(false)
const jobStateText = ref('')

async function fetchNodeLogs(params: Record<string, unknown>) {
  if (currentLogNodeId.value == null) {
    return { total: 0, items: [] as NodeLogRow[] }
  }
  return NodeAPI.listNodeLogs(currentLogNodeId.value, params)
}

const {
  columns: logColumns,
  columnChecks: logColumnChecks,
  data: logTableData,
  loading: logLoading,
  pagination: logPagination,
  getData: getLogData,
  replaceSearchParams: replaceLogSearchParams,
  resetSearchParams: resetLogSearchParams,
  handleSizeChange: logHandleSizeChange,
  handleCurrentChange: logHandleCurrentChange,
  refreshData: refreshLogData
} = useTable({
  core: {
    apiFn: fetchNodeLogs,
    immediate: false,
    apiParams: { page_no: 1, page_size: 10, status: undefined, trigger_type: undefined },
    paginationKey: { current: 'page_no', size: 'page_size' },
    columnsFactory: (): ColumnOption<NodeLogRow>[] => [
      { type: 'globalIndex', width: 56, label: '序号' },
      { prop: 'job_id', label: '任务ID', minWidth: 80, showOverflowTooltip: true },
      { prop: 'job_name', label: '任务名称', minWidth: 140, showOverflowTooltip: true },
      { prop: 'trigger_type', label: '触发方式', minWidth: 110, useSlot: true },
      { prop: 'status', label: '状态', minWidth: 90, useSlot: true },
      { prop: 'next_run_time', label: '下次执行时间', minWidth: 180, showOverflowTooltip: true },
      { prop: 'result', label: '执行结果', minWidth: 120, showOverflowTooltip: true },
      { prop: 'error', label: '错误信息', minWidth: 120, showOverflowTooltip: true },
      { prop: 'job_state', label: '执行元数据', minWidth: 100, useSlot: true },
      { prop: 'created_time', label: '创建时间', minWidth: 160, showOverflowTooltip: true }
    ]
  }
})

function logTriggerLabel(t?: string) {
  const map: Record<string, string> = {
    cron: 'Cron表达式',
    interval: '时间间隔',
    date: '固定日期',
    manual: '一次性任务'
  }
  return (t && map[t]) || t || '—'
}

function logStatusLabel(status?: number) {
  const map: Record<number, string> = {
    0: '待执行',
    1: '执行中',
    2: '成功',
    3: '失败',
    4: '超时',
    5: '已取消'
  }
  return status != null ? map[status] ?? String(status) : '—'
}

function logStatusTagType(status?: number) {
  switch (status) {
    case 1:
      return 'primary'
    case 2:
      return 'success'
    case 3:
      return 'danger'
    case 4:
      return 'warning'
    default:
      return 'info'
  }
}

async function handleOpenLogDrawer(row: NodeTable) {
  if (row.id == null) return
  currentLogNodeId.value = row.id
  currentLogNodeName.value = row.name || ''
  logSearchForm.value = { status: undefined, trigger_type: undefined }
  logDrawerVisible.value = true
  await nextTick()
  replaceLogSearchParams({
    page_no: 1,
    page_size: 10,
    status: undefined,
    trigger_type: undefined
  })
  await getLogData()
}

function handleLogSearch() {
  if (currentLogNodeId.value == null) return
  replaceLogSearchParams({
    status: logSearchForm.value.status,
    trigger_type: logSearchForm.value.trigger_type
  })
  getLogData()
}

async function onLogResetSearch() {
  logSearchForm.value = { status: undefined, trigger_type: undefined }
  await resetLogSearchParams()
}

function handleViewJobState(jobState?: string) {
  if (!jobState) return
  try {
    jobStateText.value = JSON.stringify(JSON.parse(jobState), null, 2)
  } catch {
    jobStateText.value = jobState
  }
  jobStateVisible.value = true
}
</script>

<style scoped>
.w-full {
  width: 100%;
}
.code-label {
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.dynamic-params {
  width: 100%;
}
.param-item {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.param-key {
  max-width: 100px;
}
.node-log-drawer {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
  min-height: 420px;
}
.node-log-table-card {
  flex: 1;
  min-height: 280px;
}
.job-state-pre {
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
</style>

<style lang="scss">
/* vue3-cron-plus 全局样式误伤多选 tag */
.node-cron-popover-fix {
  .vue3-cron-plus-container .el-select .el-tag {
    margin-left: 0 !important;
  }
}
</style>
