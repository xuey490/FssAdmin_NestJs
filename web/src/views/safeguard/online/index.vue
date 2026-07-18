<template>
    <ArtPageReady variant="table">
<div class="art-full-height">
    <TableSearch v-model="searchForm" @search="handleSearch" @reset="resetSearchParams" />

    <ElCard class="art-table-card" shadow="never">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="refreshData" />

      <ArtTable
        row-key="tokenId"
        :loading="loading"
        :data="data"
        :columns="columns"
        :pagination="pagination"
        @sort-change="handleSortChange"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #operation="{ row }">
          <div class="flex gap-2">
            <SaButton
              v-permission="'monitor:online:forceLogout'"
              text="强退"
              type="error"
              @click="handleForceLogout(row)"
            />
          </div>
        </template>
      </ArtTable>
    </ElCard>
  </div>
  </ArtPageReady>
</template>

<script setup lang="ts">
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTable } from '@/hooks/core/useTable'
  import api from '@/api/safeguard/online'
  import TableSearch from './modules/table-search.vue'

  // 搜索表单
  const searchForm = ref({
    ipaddr: undefined,
    userName: undefined,
    orderField: 'loginTime',
    orderType: 'desc'
  })

  // 搜索处理
  const handleSearch = (params: Record<string, any>) => {
    Object.assign(searchParams, params)
    getData()
  }

  // 表格配置
  const {
    columns,
    columnChecks,
    data,
    loading,
    getData,
    searchParams,
    pagination,
    resetSearchParams,
    handleSortChange,
    handleSizeChange,
    handleCurrentChange,
    refreshData
  } = useTable({
    core: {
      apiFn: api.list,
      apiParams: {
        ...searchForm.value
      },
      columnsFactory: () => [
        { type: 'index', label: '序号', width: 70 },
        { prop: 'tokenId', label: '会话编号', minWidth: 220, showOverflowTooltip: true },
        { prop: 'userName', label: '登录账号', width: 120 },
        { prop: 'deptName', label: '所属部门', width: 140 },
        { prop: 'ipaddr', label: '主机', width: 140 },
        { prop: 'loginLocation', label: '登录地点', minWidth: 180, showOverflowTooltip: true },
        { prop: 'os', label: '操作系统', width: 120 },
        { prop: 'browser', label: '浏览器', minWidth: 160, showOverflowTooltip: true },
        { prop: 'loginTime', label: '登录时间', width: 180, sortable: true },
        { prop: 'operation', label: '操作', width: 90, fixed: 'right', useSlot: true }
      ]
    }
  })

  // 强制下线
  const handleForceLogout = async (row: Record<string, any>) => {
    if (!row?.tokenId) {
      ElMessage.warning('会话标识不存在，无法强退')
      return
    }

    await ElMessageBox.confirm(`确认强制下线用户【${row.userName || '-'}】吗？`, '提示', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消'
    })

    await api.forceLogout(row.tokenId)
    ElMessage.success('强退成功')
    refreshData()
  }
</script>
