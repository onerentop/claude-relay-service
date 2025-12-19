<template>
  <div class="space-y-6">
    <!-- Gemini Direct Toggle -->
    <div class="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-lg font-medium text-gray-900 dark:text-white">
            Gemini Direct Connection
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Route Claude requests directly to Gemini API for lower latency.
          </p>
        </div>
        <button
          :class="[
            geminiDirectEnabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700',
            'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2'
          ]"
          @click="toggleGeminiDirect"
        >
          <span
            :class="[
              geminiDirectEnabled ? 'translate-x-5' : 'translate-x-0',
              'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out'
            ]"
          />
        </button>
      </div>
    </div>

    <!-- System Prompt -->
    <div class="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
      <h3 class="mb-4 text-lg font-medium text-gray-900 dark:text-white">Custom System Prompt</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Prompt Content</label
          >
          <textarea
            v-model="systemPrompt.prompt"
            class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white sm:text-sm"
            placeholder="Enter custom system prompt..."
            rows="4"
          ></textarea>
        </div>
        <div>
          <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Position</label
          >
          <div class="flex items-center space-x-4">
            <label class="inline-flex items-center">
              <input
                v-model="systemPrompt.position"
                class="form-radio text-blue-600"
                type="radio"
                value="prepend"
              />
              <span class="ml-2 text-gray-700 dark:text-gray-300">Prepend (Before original)</span>
            </label>
            <label class="inline-flex items-center">
              <input
                v-model="systemPrompt.position"
                class="form-radio text-blue-600"
                type="radio"
                value="append"
              />
              <span class="ml-2 text-gray-700 dark:text-gray-300">Append (After original)</span>
            </label>
          </div>
        </div>
        <div class="flex justify-end">
          <button
            class="inline-flex justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            @click="saveSystemPrompt"
          >
            Save Prompt
          </button>
        </div>
      </div>
    </div>

    <!-- Model Mapping -->
    <div class="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Model Mapping</h3>
        <button
          class="inline-flex items-center rounded border border-transparent bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300"
          @click="addMapping"
        >
          Add Mapping
        </button>
      </div>

      <div class="space-y-2">
        <div
          v-for="(target, source) in modelMapping"
          :key="source"
          class="flex items-center space-x-2"
        >
          <input
            class="flex-1 rounded-md border-gray-300 bg-gray-100 px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 sm:text-sm"
            disabled
            :value="source"
          />
          <span class="text-gray-500">→</span>
          <input
            v-model="modelMapping[source]"
            class="flex-1 rounded-md border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white sm:text-sm"
          />
          <button class="text-red-600 hover:text-red-800" @click="removeMapping(source)">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M6 18L18 6M6 6l12 12"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
          </button>
        </div>

        <!-- New Mapping Input -->
        <div
          v-if="showAddMapping"
          class="flex items-center space-x-2 rounded bg-gray-50 p-2 dark:bg-gray-700/50"
        >
          <input
            v-model="newMapping.source"
            class="flex-1 rounded-md border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white sm:text-sm"
            placeholder="Claude Model (e.g. claude-3-5-sonnet-20241022)"
          />
          <span class="text-gray-500">→</span>
          <input
            v-model="newMapping.target"
            class="flex-1 rounded-md border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white sm:text-sm"
            placeholder="Gemini Model (e.g. gemini-2.0-flash)"
          />
          <button class="text-green-600 hover:text-green-800" @click="confirmAddMapping">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M5 13l4 4L19 7"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
          </button>
          <button class="text-gray-500 hover:text-gray-700" @click="showAddMapping = false">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M6 18L18 6M6 6l12 12"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="mt-4 flex justify-end">
        <button
          class="inline-flex justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          @click="saveMapping"
        >
          Save Mapping
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { showToast } from '@/utils/toast'

const userStore = useUserStore()
const geminiDirectEnabled = ref(false)
const systemPrompt = ref({ prompt: '', position: 'append' })
const modelMapping = ref({})
const showAddMapping = ref(false)
const newMapping = ref({ source: '', target: '' })

onMounted(async () => {
  try {
    const config = await userStore.getUserConfig()
    if (config) {
      geminiDirectEnabled.value = config.geminiDirectEnabled || false
      systemPrompt.value = config.systemPrompt || { prompt: '', position: 'append' }
      modelMapping.value = config.modelMapping || {}
    }
  } catch (error) {
    showToast('Failed to load configuration', 'error')
  }
})

const toggleGeminiDirect = async () => {
  const newValue = !geminiDirectEnabled.value
  try {
    await userStore.updateGeminiDirectEnabled(newValue)
    geminiDirectEnabled.value = newValue
    showToast(`Gemini Direct ${newValue ? 'enabled' : 'disabled'}`, 'success')
  } catch (error) {
    showToast('Failed to update settings', 'error')
  }
}

const saveSystemPrompt = async () => {
  try {
    await userStore.updateSystemPrompt(systemPrompt.value.prompt, systemPrompt.value.position)
    showToast('System prompt saved', 'success')
  } catch (error) {
    showToast('Failed to save system prompt', 'error')
  }
}

const addMapping = () => {
  newMapping.value = { source: '', target: '' }
  showAddMapping.value = true
}

const confirmAddMapping = () => {
  if (newMapping.value.source && newMapping.value.target) {
    modelMapping.value[newMapping.value.source] = newMapping.value.target
    showAddMapping.value = false
    newMapping.value = { source: '', target: '' }
  }
}

const removeMapping = (source) => {
  delete modelMapping.value[source]
}

const saveMapping = async () => {
  try {
    await userStore.updateModelMapping(modelMapping.value)
    showToast('Model mapping saved', 'success')
  } catch (error) {
    showToast('Failed to save mapping', 'error')
  }
}
</script>
