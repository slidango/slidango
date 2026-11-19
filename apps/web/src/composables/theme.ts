import { ref, watch } from 'vue'

export type Theme = 'dark' | 'light'
const KEY = 'slidango-theme'

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** App theme: dark by default, light on request (remembered per browser). */
export const theme = ref<Theme>(stored())

watch(
  theme,
  (value) => {
    document.documentElement.dataset.theme = value
    try {
      localStorage.setItem(KEY, value)
    } catch {
      /* private mode: the toggle still works for this tab */
    }
  },
  { immediate: true },
)

export function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}
