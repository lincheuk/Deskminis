import { createApp } from 'vue';
import { createPinia } from 'pinia';
// T 波：新设计系统。tokens.css 暂留——T5 前仍有复用的旧组件（MarkdownView/DiffView 等）
// 引着旧令牌，T6 清场时随旧组件一并删除。
import './styles/theme.css';
import './styles/tokens.css';
import AppShell from './ui/AppShell.vue';
createApp(AppShell).use(createPinia()).mount('#app');
