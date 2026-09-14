// calculates taxable income
// 

use crate::personal_income_tax::deductions::{Deductions, totalDeductions};
use crate::personal_income_tax::adjustments::{Adjustments, agi};
use crate::personal_income_tax::income::Taxpayer;

pub fn taxable_inc(taxpayer: &Taxpayer, adjustments: &Adjustments, deductions: &Deductions) -> f64{
    let agi_total = agi(taxpayer, adjustments);
    (agi_total - totalDeductions(deductions)).max(0.0)
}
