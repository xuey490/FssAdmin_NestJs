<!-- 调度器监控：搜索 + 状态栏 + 任务卡片；抽屉内执行日志用 ArtTable -->
<template>
  <div class="art-full-height job-page flex flex-col min-h-0">
    <ArtPageReady variant="table">
      <SaSearchBar
        v-show="showSearchBar"
        v-model="searchForm"
        label-width="80px"
        :show-expand="false"
        @search="handleSearch"
        @reset="onResetSearch"
      >
        <ElCol :xs="24" :sm="12" :md="6" :lg="6">
          <ElFormItem label="任务名称" prop="name">
            <ElInput v-model="searchForm.name" placeholder="请输入任务名称" clearable />
          </ElFormItem>
        </ElCol>
        <ElCol :xs="24" :sm="12" :md="6" :lg="6">
          <ElFormItem label="任务状态" prop="status">
            <ElSelect v-model="searchForm.status" placeholder="请选择状态" clearable class="w-full">
              <ElOption label="运行中" :value="0" />
              <ElOption label="暂停中" :value="1" />
              <ElOption label="已停止" :value="2" />
            </ElSelect>
          </ElFormItem>
        </ElCol>
      </SaSearchBar>

      <ElCard
        class="art-table-card job-page-card flex flex-1 min-h-0 flex-col"
        shadow="never"
        :style="{ 'margin-top': showSearchBar ? '12px' : '0' }"
      >
        <ArtTableHeader
          v-model:columns="jobColumnChecks"
          v-model:showSearchBar="showSearchBar"
          layout="search,refresh"
          :loading="jobLoading"
          @refresh="refreshJobList"
        >
          <template #left>
            <div class="scheduler-inline">
              <div class="scheduler-metrics">
                <div class="scheduler-metric">
                  <span class="scheduler-metric__label">调度器</span>
                  <ElTag
                    :type="getSchedulerStatusType(schedulerStatus.status)"
                    size="small"
                    effect="dark"
                  >
                    {{ getSchedulerStatusLabel(schedulerStatus.status) }}
                  </ElTag>
                </div>
                <ElDivider direction="vertical" />
                <div class="scheduler-metric">
                  <span class="scheduler-metric__label">运行中</span>
                  <ElTag
                    :type="schedulerStatus.is_running ? 'success' : 'info'"
                    size="small"
                    effect="dark"
                  >
                    {{ schedulerStatus.is_running ? '是' : '否' }}
                  </ElTag>
                </div>
                <ElDivider direction="vertical" />
                <div class="scheduler-metric">
                  <span class="scheduler-metric__label">任务</span>
                  <span class="scheduler-metric__count">{{ schedulerStatus.job_count }}</span>
                </div>
              </div>
              <ElDivider direction="vertical" />
              <div class="scheduler-actions">
                <ElButton
                  v-permission="'module_task:cronjob:job:scheduler'"
                  type="success"
                  size="small"
                  :disabled="schedulerStatus.status !== '停止'"
                  @click="handleStartScheduler"
                >
                  <template #icon><ArtSvgIcon icon="ri:play-fill" /></template>
                  启动
                </ElButton>
                <ElButton
                  v-permission="'module_task:cronjob:job:scheduler'"
                  type="warning"
                  size="small"
                  :disabled="schedulerStatus.status !== '运行中'"
                  @click="handlePauseScheduler"
                >
                  <template #icon><ArtSvgIcon icon="ri:pause-fill" /></template>
                  暂停
                </ElButton>
                <ElButton
                  v-permission="'module_task:cronjob:job:scheduler'"
                  type="primary"
                  size="small"
                  :disabled="schedulerStatus.status !== '暂停'"
                  @click="handleResumeScheduler"
                >
                  <template #icon><ArtSvgIcon icon="ri:play-circle-line" /></template>
                  恢复
                </ElButton>
                <ElButton
                  v-permission="'module_task:cronjob:job:scheduler'"
                  type="danger"
                  size="small"
                  :disabled="schedulerStatus.status === '停止'"
                  @click="handleShutdownScheduler"
                >
                  <template #icon><ArtSvgIcon icon="ri:shut-down-line" /></template>
                  关闭
                </ElButton>
                <ElDivider direction="vertical" />
                <ElButton
                  v-permission="'module_task:cronjob:job:task'"
                  type="danger"
                  size="small"
                  plain
                  :disabled="schedulerStatus.job_count === 0"
                  @click="handleClearAllJobs"
                >
                  <template #icon><ArtSvgIcon icon="ri:delete-bin-line" /></template>
                  清空任务
                </ElButton>
                <ElButton
                  v-permission="'module_task:cronjob:job:query'"
                  type="info"
                  size="small"
                  @click="handleOpenConsole"
                >
                  <template #icon><ArtSvgIcon icon="ri:terminal-box-line" /></template>
                  控制台
                </ElButton>
                <ElButton
                  v-permission="'module_task:cronjob:job:update'"
                  type="primary"
                  size="small"
                  plain
                  @click="handleSyncJobs"
                >
                  <template #icon><ArtSvgIcon icon="ri:refresh-line" /></template>
                  同步
                </ElButton>
              </div>
            </div>
          </template>
        </ArtTableHeader>

        <ElSkeleton
          v-if="jobLoading && jobList.length === 0"
          animated
          class="job-skeleton"
        >
          <template #template>
            <div class="job-skeleton-grid">
              <div v-for="i in 8" :key="i" class="job-skeleton-card">
                <ElSkeletonItem
                  variant="rect"
                  style="width: 100%; height: 100%; border-radius: 8px"
                />
              </div>
            </div>
          </template>
        </ElSkeleton>

        <ElScrollbar v-else class="job-cards-container mt-3 min-h-0 flex-1">
          <ElEmpty
            v-if="!jobLoading && jobList.length === 0"
            :image-size="80"
            description="暂无数据"
          />
          <ElRow v-else :gutter="16">
            <ElCol
              v-for="job in jobList"
              :key="job.id"
              :xs="24"
              :sm="12"
              :md="8"
              :lg="6"
              :xl="4"
              class="job-card-col"
            >
              <ElCard
                shadow="hover"
                :class="`job-card job-card--${getJobStatusClass(job.status)}`"
              >
                <template #header>
                  <div class="job-card-title">
                    <span
                      class="job-card-dot"
                      :class="`job-card-dot--${getJobStatusClass(job.status)}`"
                    />
                    <span class="job-card-name" :title="job.name">{{ job.name }}</span>
                    <ElTag :type="getJobStatusType(job.status)" size="small" effect="dark">
                      {{ getJobStatusLabel(job.status) }}
                    </ElTag>
                  </div>
                </template>

                <div class="job-card-body">
                  <div class="job-card-body-row">
                    <ArtSvgIcon
                      :icon="getTriggerIcon(job.trigger)"
                      class="job-card-meta-icon"
                    />
                    <span class="job-card-meta-text">{{ formatTrigger(job.trigger) }}</span>
                  </div>
                  <div class="job-card-body-row">
                    <ArtSvgIcon icon="ri:time-line" class="job-card-meta-icon" />
                    <span class="job-card-meta-text">{{ job.next_run_time || '暂无' }}</span>
                  </div>
                </div>

                <template #footer>
                  <ElRow :gutter="8">
                    <ElCol :span="6">
                      <ElButton
                        v-permission="'module_task:cronjob:job:task'"
                        :type="job.status === 1 ? 'primary' : 'warning'"
                        size="small"
                        plain
                        class="w-full"
                        :disabled="job.status !== 1 && job.status !== 0"
                        @click="job.status === 1 ? handleResumeJob(job.id) : handlePauseJob(job.id)"
                      >
                        {{ job.status === 1 ? '恢复' : '暂停' }}
                      </ElButton>
                    </ElCol>
                    <ElCol :span="6">
                      <ElButton
                        v-permission="'module_task:cronjob:job:task'"
                        type="success"
                        size="small"
                        plain
                        class="w-full"
                        :disabled="job.status === 2 || job.status === 3"
                        @click="handleRunJobNow(job.id)"
                      >
                        调试
                      </ElButton>
                    </ElCol>
                    <ElCol :span="6">
                      <ElButton
                        v-permission="'module_task:cronjob:job:query'"
                        type="info"
                        size="small"
                        plain
                        class="w-full"
                        @click="handleOpenExecutionLogDrawer(job)"
                      >
                        记录
                      </ElButton>
                    </ElCol>
                    <ElCol :span="6">
                      <ElButton
                        v-permission="'module_task:cronjob:job:task'"
                        type="danger"
                        size="small"
                        plain
                        class="w-full"
                        :disabled="job.status === 3"
                        @click="handleRemoveJob(job.id)"
                      >
                        移除
                      </ElButton>
                    </ElCol>
                  </ElRow>
                </template>
              </ElCard>
            </ElCol>
          </ElRow>
        </ElScrollbar>
      </ElCard>
    </ArtPageReady>

    <!-- 仅打开时挂载，避免终端组件泄漏到主页面 -->
    <ElDialog
      v-model="consoleVisible"
      title="调度器控制台"
      width="900px"
      destroy-on-close
      append-to-body
    >
      <div v-if="consoleVisible" class="terminal-wrapper">
        <Terminal name="scheduler-console" :show-header="false" theme="dark" />
      </div>
      <template #footer>
        <ElButton @click="handleRefreshConsole">刷新</ElButton>
        <ElButton @click="handleClearConsole">清空</ElButton>
        <ElButton type="primary" @click="consoleVisible = false">关闭</ElButton>
      </template>
    </ElDialog>

    <ElDrawer
      v-model="executionLogDrawerVisible"
      title="执行记录"
      direction="rtl"
      size="80%"
      append-to-body
    >
      <div class="execution-log-drawer flex flex-col min-h-0 h-full">
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

        <ElCard class="art-table-card log-table-card mt-3 flex flex-1 min-h-0 flex-col" shadow="never">
          <ArtTableHeader
            v-model:columns="logColumnChecks"
            layout="refresh"
            :loading="logLoading"
            @refresh="refreshLogData"
          >
            <template #left>
              <ElButton
                v-permission="'module_task:cronjob:job:delete'"
                type="danger"
                plain
                :disabled="logSelectedIds.length === 0"
                :loading="logBatchDeleting"
                @click="handleLogBatchDelete"
              >
                批量删除
              </ElButton>
            </template>
          </ArtTableHeader>
          <ArtTable
            ref="logTableRef"
            row-key="id"
            :loading="logLoading"
            :data="logTableData"
            :columns="logColumns"
            :pagination="logPagination"
            @selection-change="onLogTableSelectionChange"
            @pagination:size-change="logHandleSizeChange"
            @pagination:current-change="logHandleCurrentChange"
          >
            <template #trigger_type="{ row }">
              {{ triggerTypeLabel(row.trigger_type) }}
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
                @click="handleViewJobState(row)"
              >
                查看
              </ElButton>
              <span v-else>—</span>
            </template>
            <template #operation="{ row }">
              <SaButton
                v-permission="'module_task:cronjob:job:delete'"
                type="error"
                tool-tip="删除"
                @click="deleteLogRow(row.id)"
              />
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
      <pre class="job-state-pre">{{ formatJobState(jobStateData) }}</pre>
      <template #footer>
        <ElButton type="primary" @click="jobStateVisible = false">关闭</ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<script lang="ts" setup>
defineOptions({
  name: 'Job',
  inheritAttrs: false
})

import JobAPI, {
  type SchedulerStatus,
  type SchedulerJob,
  type JobLogTable
} from '@/api/module_task/cronjob/job'
import { useTable } from '@/hooks/core/useTable'
import type { ColumnOption } from '@/types/component'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, nextTick, onMounted, ref } from 'vue'
import { Terminal, TerminalApi } from 'vue-web-terminal'

const schedulerStatus = ref<SchedulerStatus>({
  status: '未知',
  is_running: false,
  job_count: 0
})

type JobSearchForm = {
  name?: string
  status?: number
}

const searchForm = ref<JobSearchForm>({
  name: undefined,
  status: undefined
})

const showSearchBar = ref(true)
const jobColumnChecks = ref<ColumnOption<SchedulerJob>[]>([])

const jobList = ref<SchedulerJob[]>([])
const jobLoading = ref(false)

function matchesJobStatusFilter(jobStatus: number | undefined, filter?: number): boolean {
  if (filter === undefined || filter === null) return true
  return jobStatus === filter
}

async function loadSchedulerStatus() {
  try {
    schedulerStatus.value = await JobAPI.getSchedulerStatus()
  } catch (error: unknown) {
    console.error(error)
  }
}

async function fetchSchedulerJobs() {
  jobLoading.value = true
  try {
    const raw = await JobAPI.getSchedulerJobs()
    const list: SchedulerJob[] = Array.isArray(raw) ? raw : []
    const nameQ = searchForm.value.name?.trim()
    const statusQ = searchForm.value.status
    jobList.value = list.filter((j) => {
      if (nameQ && !(j.name ?? '').includes(nameQ)) return false
      if (!matchesJobStatusFilter(j.status, statusQ)) return false
      return true
    })
    await loadSchedulerStatus()
  } catch (error: unknown) {
    console.error(error)
    jobList.value = []
  } finally {
    jobLoading.value = false
  }
}

const refreshJobList = fetchSchedulerJobs

function handleSearch() {
  void fetchSchedulerJobs()
}

function onResetSearch() {
  searchForm.value = { name: undefined, status: undefined }
  void fetchSchedulerJobs()
}

onMounted(() => {
  void fetchSchedulerJobs()
})

type LogSearchForm = {
  status?: number
  trigger_type?: string
}

const logSearchForm = ref<LogSearchForm>({
  status: undefined,
  trigger_type: undefined
})

const currentLogJobId = ref<string | undefined>(undefined)
const logTableRef = ref<{ elTableRef?: { clearSelection: () => void } } | null>(null)
const logSelectedRows = ref<JobLogTable[]>([])
const logSelectedIds = computed(() =>
  logSelectedRows.value.map((r) => r.id).filter((id): id is number => typeof id === 'number')
)
const logBatchDeleting = ref(false)

function onLogTableSelectionChange(rows: JobLogTable[]) {
  logSelectedRows.value = rows
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
  refreshData: refreshLogData,
  refreshRemove: refreshLogRemove
} = useTable({
  core: {
    apiFn: JobAPI.getJobLogList,
    immediate: false,
    apiParams: {
      page_no: 1,
      page_size: 10,
      job_id: undefined,
      status: undefined,
      trigger_type: undefined
    },
    paginationKey: { current: 'page_no', size: 'page_size' },
    columnsFactory: (): ColumnOption<JobLogTable>[] => [
      { type: 'selection', width: 48, fixed: 'left' },
      { type: 'globalIndex', width: 56, label: '序号' },
      { prop: 'job_id', label: '任务ID', minWidth: 80, showOverflowTooltip: true },
      { prop: 'job_name', label: '任务名称', minWidth: 140, showOverflowTooltip: true },
      { prop: 'trigger_type', label: '触发方式', minWidth: 120, useSlot: true },
      { prop: 'status', label: '状态', minWidth: 90, useSlot: true },
      { prop: 'next_run_time', label: '下次执行时间', minWidth: 180, showOverflowTooltip: true },
      { prop: 'result', label: '执行结果', minWidth: 100, showOverflowTooltip: true },
      { prop: 'error', label: '错误信息', minWidth: 100, showOverflowTooltip: true },
      { prop: 'job_state', label: '执行元数据', minWidth: 100, useSlot: true },
      { prop: 'created_time', label: '创建时间', minWidth: 160, showOverflowTooltip: true },
      { prop: 'operation', label: '操作', width: 80, fixed: 'right', align: 'center', useSlot: true }
    ]
  }
})

function triggerTypeLabel(t?: string) {
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

async function deleteLogRow(id: number | undefined) {
  if (id == null) return
  try {
    await ElMessageBox.confirm('确认删除该执行记录？', '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await JobAPI.deleteJobLog([id])
    logTableRef.value?.elTableRef?.clearSelection()
    await refreshLogRemove()
  } catch {
    // cancel
  }
}

async function handleLogBatchDelete() {
  const ids = logSelectedIds.value
  if (ids.length === 0) return
  try {
    await ElMessageBox.confirm('确认删除选中的执行记录？', '批量删除', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    logBatchDeleting.value = true
    await JobAPI.deleteJobLog(ids)
    logSelectedRows.value = []
    await refreshLogRemove()
  } catch {
    // cancel
  } finally {
    logBatchDeleting.value = false
  }
}

function handleLogSearch() {
  if (!currentLogJobId.value) return
  replaceLogSearchParams({
    status: logSearchForm.value.status,
    trigger_type: logSearchForm.value.trigger_type,
    job_id: currentLogJobId.value
  })
  getLogData()
}

async function onLogResetSearch() {
  logSearchForm.value = { status: undefined, trigger_type: undefined }
  await resetLogSearchParams()
  if (currentLogJobId.value) {
    replaceLogSearchParams({ job_id: currentLogJobId.value })
    getLogData()
  }
}

const consoleVisible = ref(false)
const executionLogDrawerVisible = ref(false)
const jobStateVisible = ref(false)
const jobStateData = ref<unknown>(null)

function getSchedulerStatusType(status: string) {
  switch (status) {
    case '运行中':
      return 'success'
    case '暂停':
      return 'warning'
    case '停止':
      return 'danger'
    default:
      return 'info'
  }
}

function getSchedulerStatusLabel(status: string) {
  return status || '未知'
}

function getJobStatusType(status: number) {
  switch (status) {
    case 0:
      return 'success'
    case 1:
      return 'warning'
    case 2:
      return 'danger'
    default:
      return 'info'
  }
}

function getJobStatusLabel(status: number) {
  switch (status) {
    case 0:
      return '运行中'
    case 1:
      return '暂停中'
    case 2:
      return '已停止'
    default:
      return '未知'
  }
}

function getJobStatusClass(status: number) {
  switch (status) {
    case 0:
      return 'running'
    case 1:
      return 'paused'
    case 2:
      return 'stopped'
    default:
      return 'unknown'
  }
}

function getTriggerIcon(trigger: string | undefined) {
  const t = (trigger ?? '').toLowerCase()
  if (t.includes('cron')) return 'ri:timer-line'
  if (t.includes('interval')) return 'ri:repeat-line'
  if (t.includes('date')) return 'ri:calendar-event-line'
  return 'ri:flashlight-line'
}

function formatTrigger(trigger: string) {
  if (!trigger) return '-'
  if (trigger.includes('cron')) {
    const match = trigger.match(/cron\[([^\]]+)\]/)
    if (match) {
      const params = match[1]!
      const month = params.match(/month='([^']+)'/)
      const day = params.match(/day='([^']+)'/)
      const hour = params.match(/hour='([^']+)'/)
      const minute = params.match(/minute='([^']+)'/)
      const second = params.match(/second='([^']+)'/)
      const dayOfWeek = params.match(/day_of_week='([^']+)'/)
      const parts: string[] = []
      if (second && second[1] !== '*') parts.push(`秒:${second[1]}`)
      if (minute && minute[1] !== '*') parts.push(`分:${minute[1]}`)
      if (hour && hour[1] !== '*') parts.push(`时:${hour[1]}`)
      if (day && day[1] !== '*') parts.push(`日:${day[1]}`)
      if (month && month[1] !== '*') parts.push(`月:${month[1]}`)
      if (dayOfWeek && dayOfWeek[1] !== '*') parts.push(`周:${dayOfWeek[1]}`)
      return parts.length === 0 ? 'Cron: 每分钟' : `Cron: ${parts.join(' ')}`
    }
    return trigger
  }
  if (trigger.includes('interval')) {
    const match = trigger.match(/interval\[([^\]]+)\]/)
    return match ? `间隔时长: ${match[1]}` : trigger
  }
  if (trigger.includes('date')) {
    const match = trigger.match(/date\[([^\]]+)\]/)
    return match ? `执行日期: ${match[1]}` : trigger
  }
  return trigger
}

async function handleSyncJobs() {
  try {
    await JobAPI.syncJobsToDb()
    ElMessage.success('同步成功')
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handleStartScheduler() {
  try {
    await JobAPI.startScheduler()
    ElMessage.success('启动成功')
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handlePauseScheduler() {
  try {
    await JobAPI.pauseScheduler()
    ElMessage.success('暂停成功')
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handleResumeScheduler() {
  try {
    await JobAPI.resumeScheduler()
    ElMessage.success('恢复成功')
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handleShutdownScheduler() {
  try {
    await ElMessageBox.confirm('确定要关闭调度器吗？', '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await JobAPI.shutdownScheduler()
    ElMessage.success('关闭成功')
    await refreshJobList()
  } catch {
    // cancel
  }
}

async function handleClearAllJobs() {
  try {
    await ElMessageBox.confirm(
      '确定要清空所有任务吗？\n此操作会将待执行任务日志标记为已取消，不会删除历史执行记录。',
      '警告',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    await JobAPI.clearAllJobs()
    ElMessage.success('清空成功')
    await refreshJobList()
  } catch {
    // cancel
  }
}

async function handleOpenConsole() {
  consoleVisible.value = true
  await nextTick()
  await handleRefreshConsole()
}

async function handleRefreshConsole() {
  try {
    const data = (await JobAPI.getSchedulerConsole()) || '暂无任务信息'
    TerminalApi.pushMessage('scheduler-console', { type: 'normal', content: data })
  } catch (e) {
    console.error(e)
    TerminalApi.pushMessage('scheduler-console', {
      type: 'normal',
      class: 'error',
      content: '获取控制台信息失败'
    })
  }
}

function handleClearConsole() {
  TerminalApi.clear('scheduler-console')
}

async function handlePauseJob(jobId: string) {
  try {
    await JobAPI.pauseJob(jobId)
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handleResumeJob(jobId: string) {
  try {
    await JobAPI.resumeJob(jobId)
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handleRunJobNow(jobId: string) {
  try {
    await JobAPI.runJobNow(jobId)
    await refreshJobList()
  } catch (e) {
    console.error(e)
  }
}

async function handleRemoveJob(jobId: string) {
  try {
    await ElMessageBox.confirm('确认移除该任务?', '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await JobAPI.removeJob(jobId)
    await refreshJobList()
  } catch {
    // cancel
  }
}

async function handleOpenExecutionLogDrawer(job: SchedulerJob) {
  currentLogJobId.value = job.id
  logSearchForm.value = { status: undefined, trigger_type: undefined }
  executionLogDrawerVisible.value = true
  await nextTick()
  replaceLogSearchParams({
    job_id: job.id,
    page_no: 1,
    page_size: 10,
    status: undefined,
    trigger_type: undefined
  })
  await getLogData()
}

function handleViewJobState(row: JobLogTable) {
  const jobState = row.job_state
  if (!jobState) return
  try {
    jobStateData.value = JSON.parse(jobState)
  } catch {
    jobStateData.value = jobState
  }
  jobStateVisible.value = true
}

function formatJobState(data: unknown) {
  if (data == null) return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}
</script>

<style scoped lang="scss">
.terminal-wrapper {
  height: 500px;
}

.job-state-pre {
  max-height: 420px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.scheduler-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;

  .el-divider--vertical {
    height: 18px;
    margin: 0 2px;
  }
}

.scheduler-metrics {
  display: flex;
  gap: 4px;
  align-items: center;
}

.scheduler-metric {
  display: flex;
  gap: 4px;
  align-items: center;
  white-space: nowrap;

  &__label {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &__count {
    font-size: 14px;
    font-weight: 700;
    color: var(--el-color-warning);
  }
}

.scheduler-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;

  .el-divider--vertical {
    height: 18px;
    margin: 0 2px;
  }
}

.job-page-card {
  :deep(.el-card__body) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
}

.job-card-col {
  margin-bottom: 16px;
}

.job-card {
  transition: box-shadow 0.25s;

  &:hover {
    box-shadow: 0 4px 12px rgb(0 0 0 / 6%);
  }

  :deep(.el-card__header) {
    padding: 8px 14px;
  }

  :deep(.el-card__body) {
    padding: 8px 14px;
  }

  :deep(.el-card__footer) {
    padding: 8px 14px;
  }
}

.job-card-title {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.job-card-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;

  &--running {
    background: var(--el-color-success);
  }

  &--paused {
    background: var(--el-color-warning);
  }

  &--stopped {
    background: var(--el-color-danger);
  }

  &--unknown {
    background: var(--el-color-info);
  }
}

.job-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow: hidden;

  &-row {
    display: flex;
    gap: 4px;
    align-items: center;
    min-width: 0;
    overflow: hidden;
  }
}

.job-card-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.job-card-meta-icon {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--el-color-primary-light-3);
}

.job-card-meta-text {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.execution-log-drawer {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
  min-height: 420px;
}

.log-table-card {
  flex: 1;
  min-height: 280px;

  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 280px;
  }
}

.job-skeleton {
  margin-top: 12px;
}

.job-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.job-skeleton-card {
  height: 200px;
}
</style>
