import { calculate } from '../lib/calc.js';
const cases = [
 '45 * 12','(3+4)*2','2^3^2','-5+3','10%3','0.1+0.2','sqrt(144)','sin(pi/2)','log10(1000)','ln(e)',
 'max(3,7,2)','min(4,1)','5!','10/0','2^10','abs(-9)','hypot(3,4)','pi*2','1e3+1','round(2.6)',
 'pow(2,10)','(1+2)*(3+4)','100/4/5','3.5%1','tan(0)','fact' , 'foo(3)', '12+', '', 'cbrt(27)',
 '45*12 + sqrt(144)^2', 'atan2(1,1)*180/pi', '2^-3', '1/3'
];
for (const c of cases) {
  const r = calculate(c);
  console.log(String(JSON.stringify(c)).padEnd(28), r.ok ? ('= ' + r.display).padEnd(26) : ('ERR: ' + r.error));
}
