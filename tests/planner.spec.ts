import { expect, test } from '@playwright/test';
import { ReadingWindow } from '../content/planner';

test('默认预取前方两屏，反向滚动预取上方，快速跳页只处理当前屏', () => {
  const window = new ReadingWindow(); window.scroll(0,100);
  expect(window.priority({top:1200,bottom:1500,height:300},1000,100)).toBe(1);
  expect(window.priority({top:2800,bottom:3100,height:300},1000,100)).toBe(1);
  expect(window.priority({top:3200,bottom:3500,height:300},1000,100)).toBeNull();
  window.scroll(5000,200);
  expect(window.priority({top:1100,bottom:1400,height:300},1000,200)).toBeNull();
  expect(window.priority({top:100,bottom:400,height:300},1000,200)).toBe(0);
  expect(window.priority({top:1100,bottom:1400,height:300},1000,400)).toBe(1);
  window.scroll(4800,600);
  expect(window.priority({top:-800,bottom:-500,height:300},1000,600)).toBe(1);
  expect(window.priority({top:1200,bottom:1500,height:300},1000,600)).toBeNull();
});

test('按阅读速度和近期耗时扩展预取，但不超过三屏', () => {
  const window = new ReadingWindow(); window.scroll(0,100); window.scroll(900,1000); window.completed(4000);
  expect(window.priority({top:3600,bottom:3900,height:300},1000,1000)).toBe(1);
  expect(window.priority({top:3800,bottom:4100,height:300},1000,1000)).toBeNull();
  window.completed(4000); window.completed(4000); window.completed(4000);
  expect(window.priority({top:3900,bottom:4200,height:300},1000,1000)).toBe(1);
  expect(window.priority({top:4100,bottom:4400,height:300},1000,1000)).toBeNull();
});
