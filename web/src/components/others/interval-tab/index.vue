<!-- 间隔触发：输出「秒 分 时 天 周」供 APScheduler IntervalTrigger -->
<template>
  <div class="interval-tab">
    <ElForm label-width="72px" size="small">
      <ElFormItem label="秒">
        <ElInputNumber v-model="seconds" :min="0" :max="59" controls-position="right" class="w-full" />
      </ElFormItem>
      <ElFormItem label="分">
        <ElInputNumber v-model="minutes" :min="0" :max="59" controls-position="right" class="w-full" />
      </ElFormItem>
      <ElFormItem label="时">
        <ElInputNumber v-model="hours" :min="0" :max="23" controls-position="right" class="w-full" />
      </ElFormItem>
      <ElFormItem label="天">
        <ElInputNumber v-model="days" :min="0" :max="365" controls-position="right" class="w-full" />
      </ElFormItem>
      <ElFormItem label="周">
        <ElInputNumber v-model="weeks" :min="0" :max="52" controls-position="right" class="w-full" />
      </ElFormItem>
    </ElForm>
    <div class="interval-tab__preview">预览：{{ preview }}</div>
    <div class="interval-tab__actions">
      <ElButton size="small" @click="emit('cancel')">取消</ElButton>
      <ElButton type="primary" size="small" @click="onConfirm">确定</ElButton>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'IntervalTab' })

const props = defineProps<{ cronValue?: string }>()
const emit = defineEmits<{
  confirm: [value: string]
  cancel: []
}>()

const seconds = ref(0)
const minutes = ref(5)
const hours = ref(0)
const days = ref(0)
const weeks = ref(0)

function parse(v?: string) {
  if (!v?.trim()) return
  const parts = v.trim().split(/\s+/)
  if (parts.length !== 5) return
  const nums = parts.map((p) => (p === '*' ? 0 : Number(p)))
  if (nums.some((n) => !Number.isFinite(n))) return
  seconds.value = nums[0]!
  minutes.value = nums[1]!
  hours.value = nums[2]!
  days.value = nums[3]!
  weeks.value = nums[4]!
}

watch(
  () => props.cronValue,
  (v) => parse(v),
  { immediate: true }
)

const preview = computed(
  () => `${seconds.value} ${minutes.value} ${hours.value} ${days.value} ${weeks.value}`
)

function onConfirm() {
  emit('confirm', preview.value)
}
</script>

<style scoped>
.interval-tab {
  padding: 8px 4px 0;
}
.interval-tab__preview {
  margin: 4px 0 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.interval-tab__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.w-full {
  width: 100%;
}
</style>
