import { createApp } from 'vue';
import { createPinia } from 'pinia';
// T 波：新设计系统。tokens.css **暂留**——钉子是 MarkdownView（消费 14 个只在它里面
// 声明的变量）与 MarkdownInline（4 个），两者仍活。T6d 已让两套同名令牌同值，
// 将来把这 18 个变量搬进 theme.css 后即可删；T6e 清场只删了旧组件树，不动它。
// （此前注释写的是「DiffView 等」——DiffView 早就死了，T6e 一并删掉；钉子从来不是它。）
import './styles/theme.css';
import './styles/tokens.css';
import AppShell from './ui/AppShell.vue';
createApp(AppShell).use(createPinia()).mount('#app');
