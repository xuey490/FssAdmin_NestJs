<!-- 视图首屏骨架：稳定单根 + v-show，兼容 KeepAlive / 路由 Transition -->
<template>
  <div class="art-page-ready-root">
    <div
      v-show="loading"
      class="art-page-ready"
      aria-busy="true"
      aria-live="polite"
    >
      <!-- dashboard：统计卡片 + 图表区 -->
      <template v-if="variant === 'dashboard'">
        <ElRow :gutter="20" class="mb-5">
          <ElCol v-for="i in 4" :key="`stat-${i}`" :xs="12" :sm="12" :md="6" :lg="6">
            <div class="art-page-ready__block art-page-ready__stat">
              <ElSkeleton animated>
                <template #template>
                  <div class="flex items-center gap-3 p-1">
                    <ElSkeletonItem variant="circle" style="width: 42px; height: 42px" />
                    <div class="flex-1">
                      <ElSkeletonItem variant="text" style="width: 40%; margin-bottom: 10px" />
                      <ElSkeletonItem variant="h3" style="width: 55%" />
                    </div>
                  </div>
                </template>
              </ElSkeleton>
            </div>
          </ElCol>
        </ElRow>

        <ElRow :gutter="20" class="mb-5">
          <ElCol :xs="24" :md="12" :lg="10">
            <div class="art-page-ready__block art-page-ready__chart">
              <ElSkeleton animated>
                <template #template>
                  <ElSkeletonItem variant="h3" style="width: 30%; margin-bottom: 16px" />
                  <ElSkeletonItem variant="rect" style="width: 100%; height: 220px" />
                </template>
              </ElSkeleton>
            </div>
          </ElCol>
          <ElCol :xs="24" :md="12" :lg="14">
            <div class="art-page-ready__block art-page-ready__chart">
              <ElSkeleton animated>
                <template #template>
                  <ElSkeletonItem variant="h3" style="width: 30%; margin-bottom: 16px" />
                  <ElSkeletonItem variant="rect" style="width: 100%; height: 220px" />
                </template>
              </ElSkeleton>
            </div>
          </ElCol>
        </ElRow>

        <ElRow :gutter="20">
          <ElCol :xs="24" :md="12" :lg="12">
            <div class="art-page-ready__block art-page-ready__list">
              <ElSkeleton animated :rows="5" />
            </div>
          </ElCol>
          <ElCol :xs="24" :md="12" :lg="12">
            <div class="art-page-ready__block art-page-ready__list">
              <ElSkeleton animated :rows="5" />
            </div>
          </ElCol>
        </ElRow>
      </template>

      <!-- analysis / ecommerce -->
      <template v-else-if="variant === 'grid'">
        <ElRow :gutter="20" class="mb-5">
          <ElCol :xs="24" :lg="14">
            <div class="art-page-ready__block art-page-ready__chart">
              <ElSkeleton animated>
                <template #template>
                  <ElSkeletonItem variant="h3" style="width: 28%; margin-bottom: 16px" />
                  <ElSkeletonItem variant="rect" style="width: 100%; height: 200px" />
                </template>
              </ElSkeleton>
            </div>
          </ElCol>
          <ElCol :xs="24" :lg="10">
            <div class="art-page-ready__block art-page-ready__chart">
              <ElSkeleton animated>
                <template #template>
                  <ElSkeletonItem variant="h3" style="width: 28%; margin-bottom: 16px" />
                  <ElSkeletonItem variant="rect" style="width: 100%; height: 200px" />
                </template>
              </ElSkeleton>
            </div>
          </ElCol>
        </ElRow>
        <ElRow :gutter="20" class="mb-5">
          <ElCol v-for="i in 3" :key="`mid-${i}`" :xs="24" :lg="8">
            <div class="art-page-ready__block art-page-ready__chart">
              <ElSkeleton animated>
                <template #template>
                  <ElSkeletonItem variant="h3" style="width: 40%; margin-bottom: 16px" />
                  <ElSkeletonItem variant="rect" style="width: 100%; height: 160px" />
                </template>
              </ElSkeleton>
            </div>
          </ElCol>
        </ElRow>
        <ElRow :gutter="20">
          <ElCol v-for="i in 3" :key="`bot-${i}`" :xs="24" :lg="8">
            <div class="art-page-ready__block art-page-ready__list">
              <ElSkeleton animated :rows="4" />
            </div>
          </ElCol>
        </ElRow>
      </template>

      <!-- 列表页：搜索 + 表格（system 等 CRUD） -->
      <template v-else-if="variant === 'table'">
        <div class="art-page-ready__block art-page-ready__search mb-4">
          <ElSkeleton animated>
            <template #template>
              <div class="flex flex-wrap gap-4">
                <ElSkeletonItem variant="text" style="width: 200px; height: 32px" />
                <ElSkeletonItem variant="text" style="width: 200px; height: 32px" />
                <ElSkeletonItem variant="text" style="width: 100px; height: 32px" />
                <ElSkeletonItem variant="text" style="width: 80px; height: 32px" />
              </div>
            </template>
          </ElSkeleton>
        </div>
        <div class="art-page-ready__block art-page-ready__table">
          <ElSkeleton animated>
            <template #template>
              <div class="flex justify-between mb-4">
                <div class="flex gap-3">
                  <ElSkeletonItem variant="text" style="width: 72px; height: 32px" />
                  <ElSkeletonItem variant="text" style="width: 72px; height: 32px" />
                </div>
                <ElSkeletonItem variant="text" style="width: 120px; height: 32px" />
              </div>
              <ElSkeletonItem variant="text" style="width: 100%; height: 40px; margin-bottom: 12px" />
              <ElSkeletonItem
                v-for="i in 8"
                :key="`row-${i}`"
                variant="text"
                style="width: 100%; height: 36px; margin-bottom: 10px"
              />
            </template>
          </ElSkeleton>
        </div>
      </template>

      <!-- 简单页 -->
      <template v-else>
        <div class="art-page-ready__block art-page-ready__hero mb-5">
          <ElSkeleton animated>
            <template #template>
              <div class="flex items-center gap-4">
                <ElSkeletonItem variant="circle" style="width: 64px; height: 64px" />
                <div class="flex-1">
                  <ElSkeletonItem variant="h3" style="width: 36%; margin-bottom: 12px" />
                  <ElSkeletonItem variant="text" style="width: 55%" />
                </div>
              </div>
            </template>
          </ElSkeleton>
        </div>
        <ElRow :gutter="20">
          <ElCol :xs="24" :md="12">
            <div class="art-page-ready__block art-page-ready__list">
              <ElSkeleton animated :rows="6" />
            </div>
          </ElCol>
          <ElCol :xs="24" :md="12">
            <div class="art-page-ready__block art-page-ready__list">
              <ElSkeleton animated :rows="6" />
            </div>
          </ElCol>
        </ElRow>
      </template>
    </div>

    <div v-show="!loading" class="art-page-ready__body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
  defineOptions({ name: 'ArtPageReady' })

  const props = withDefaults(
    defineProps<{
      variant?: 'dashboard' | 'grid' | 'table' | 'simple'
      minMs?: number
    }>(),
    {
      variant: 'dashboard',
      minMs: 320
    }
  )

  const loading = ref(true)
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const startSkeleton = () => {
    clearTimer()
    loading.value = true
    const started = Date.now()
    nextTick(() => {
      const remain = Math.max(0, props.minMs - (Date.now() - started))
      timer = setTimeout(() => {
        loading.value = false
        // 图表在 display:none 期间初始化时宽高为 0，露出后触发重绘
        nextTick(() => {
          window.dispatchEvent(new Event('resize'))
        })
      }, remain)
    })
  }

  onMounted(startSkeleton)
  // KeepAlive 再次进入时重新播骨架
  onActivated(startSkeleton)

  onDeactivated(clearTimer)
  onUnmounted(clearTimer)
</script>

<style scoped>
  .art-page-ready-root {
    width: 100%;
    min-height: 120px;
  }

  .art-page-ready__block {
    padding: 20px;
    margin-bottom: 0;
    border-radius: calc(var(--custom-radius, 8px) + 2px);
    background: var(--default-box-color, var(--el-bg-color));
    border: 1px solid var(--default-border, var(--el-border-color-lighter));
  }

  .art-page-ready__stat {
    min-height: 96px;
  }

  @media (max-width: 768px) {
    .art-page-ready__block {
      padding: 16px;
    }
  }
</style>
