import { SHIFT_HOURS_SQL_FIELDS, SHIFT_HOURS_AGG_SQL_FIELDS, BREAK_HOURS_ROW_SQL, VIOLATION_HOURS_ROW_SQL } from '../src/services/shiftHours';
console.log('===PER_SESSION===');    console.log(SHIFT_HOURS_SQL_FIELDS('ss', 'sh'));
console.log('===AGG_CANONICAL===');  console.log(SHIFT_HOURS_AGG_SQL_FIELDS('ss'));
console.log('===AGG_HPREFIX===');    console.log(SHIFT_HOURS_AGG_SQL_FIELDS('ss', 'h_prefix'));
console.log('===ROW_BREAK_bs_ss5==='); console.log(BREAK_HOURS_ROW_SQL('bs', 'ss5'));
console.log('===ROW_VIOL_gv_ss6==='); console.log(VIOLATION_HOURS_ROW_SQL('gv', 'ss6'));
process.exit(0);
