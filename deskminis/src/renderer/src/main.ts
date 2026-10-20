import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/theme.css';
import AppShell from './ui/AppShell.vue';
import { initTheme } from './lib/theme';
initTheme();
createApp(AppShell).use(createPinia()).mount('#app');
