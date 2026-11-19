import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import { reportError } from './errors'
import DeckList from './views/DeckList.vue'
import DeckEditor from './views/DeckEditor.vue'
import './style.css'
import './composables/theme'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: DeckList },
    { path: '/decks/:id', component: DeckEditor, props: true },
    { path: '/admin', redirect: { path: '/', query: { settings: null } } },
    // Target of the preview login redirect; the login form itself is shown by App.vue.
    { path: '/login', redirect: '/' },
  ],
})

const app = createApp(App)
app.config.errorHandler = (error) => {
  console.error(error)
  reportError(error)
}
window.addEventListener('unhandledrejection', (event) => reportError(event.reason))
app.use(router).mount('#app')
