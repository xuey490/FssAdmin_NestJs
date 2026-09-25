/**
 * 临时验证脚本：模拟打包产物运行时对 svg-captcha 的 require 行为。
 * 关键点：字体是 svg-captcha 用 __dirname 相对路径定位的，
 * 因此这里用 createRequire(import.meta.url)（与 bundle 内一致）验证，
 * 并在不同工作目录下各跑一次，证明不再依赖 cwd。跑完即删。
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const svgCaptcha = require('svg-captcha');

console.log('[verify] cwd =', process.cwd());

const text = svgCaptcha.create({ size: 4, noise: 2, charPreset: '0123456789' });
console.log('[verify] create()        svg 长度 =', text.data.length, '| 文本 =', text.text);

const math = svgCaptcha.createMathExpr({ mathMin: 1, mathMax: 50, mathOperator: '+' });
console.log('[verify] createMathExpr() svg 长度 =', math.data.length, '| 算式 =', math.text);

if (!text.data.startsWith('<svg') || text.data.length < 300) {
  throw new Error('验证码 SVG 输出异常');
}

console.log('[verify] PASS');
