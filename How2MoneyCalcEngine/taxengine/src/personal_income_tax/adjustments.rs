// adjustments, AGI calc
// 

use crate::personal_income_tax::income::{Taxpayer, total_income};


pub struct Adjustments{
    pub student_loan_interest: f64,
    pub trad_ira_contrib: f64,
    pub hsa_contrib: f64,
    pub health_insurance: f64,
    pub self_employment: f64,
}

pub fn totalAdjustments(sumAdjustments: &Adjustments) -> f64{
    sumAdjustments.student_loan_interest + sumAdjustments.trad_ira_contrib + sumAdjustments.hsa_contrib 
    + sumAdjustments.health_insurance + sumAdjustments.self_employment
}

pub fn agi(taxpayer: &Taxpayer, adjustments: &Adjustments) -> f64{
    total_income(taxpayer) - totalAdjustments(adjustments)
}



