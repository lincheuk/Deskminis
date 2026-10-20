/** 实时正文换成历史组件时 DOM 身份丢失，浏览器的自动锚定不能保住同一行。
 *  只在这次替换前记录首个可见正文块，替换后补偿它的位置，不改变用户的跟随意图。 */
export function holdTextAnchor(scroller: HTMLElement): (() => void) | undefined {
  const selector = '.md p, .md li, .md pre, .md h1, .md h2, .md h3, .md h4, .md h5, .md h6, .ubub';
  const blocks = [...scroller.querySelectorAll<HTMLElement>(selector)];
  const viewport = scroller.getBoundingClientRect();
  const anchor = blocks.find(el => {
    const box = el.getBoundingClientRect();
    return box.bottom > viewport.top && box.top < viewport.bottom;
  });
  if (!anchor) return;
  const text = anchor.textContent, tag = anchor.tagName, top = anchor.getBoundingClientRect().top;
  const same = (el: HTMLElement): boolean => el.tagName === tag && el.textContent === text;
  const occurrence = blocks.slice(0, blocks.indexOf(anchor)).filter(same).length;
  return () => {
    const current = [...scroller.querySelectorAll<HTMLElement>(selector)].filter(same)[occurrence];
    if (current) scroller.scrollTop += current.getBoundingClientRect().top - top;
  };
}
