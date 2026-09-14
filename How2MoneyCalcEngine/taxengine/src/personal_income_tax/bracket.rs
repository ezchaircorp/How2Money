// individual and joint income tax stufffffffff 
// tax brackets


// Taxable income is calculated after determining:
// - income from all applicable sources
// - filing status
// - adjustments to income (to determine AGI)   
// - deductions
//
// Tax credits are applied AFTER taxable income is calculated
// and the initial tax liability has been determined.
// 
// 
// gotta rewrite this whxole thing lmao idk shit about this:
// taxes are marginal — each rate only applies to the slice of income within that bracket, not the whole amount.


use crate::personal_income_tax::{adjustments::Adjustments, deductions::{self, Deductions}, taxable_income::taxable_inc};
use crate::personal_income_tax::income::{Taxpayer};

struct Bracket{
    upper: f64,
    rate: f64,
}

pub fn bracket_application(income: f64, brackets: &[Bracket]) -> f64{
    let mut tax = 0.0;
    let mut lower = 0.0;
    
    for bracket in brackets{
        if income > lower{
            let taxable_bracket = (income.min(bracket.upper)) - lower;
            tax += taxable_bracket * bracket.rate;
            lower = bracket.upper;
        }
        else{
            break;
        }
    }
    tax
}

pub fn single() -> Vec<Bracket>{
    vec![
        Bracket {upper: 11925.0, rate: 0.10},
        Bracket {upper: 48475.0, rate: 0.12},
        Bracket {upper: 103350.0, rate: 0.22}
    ]
}

pub fn joint() -> Vec<Bracket>{
    vec![
        Bracket {upper: 23850.0, rate: 0.10},
        Bracket {upper: 96950.0, rate: 0.12},
        Bracket {upper: 206700.0, rate: 0.22}
    ]
}

pub fn calcuate_tax(adjustments: &Adjustments, deductions: &Deductions, taxpayer: &Taxpayer) -> f64{
    let income = taxable_inc(taxpayer, adjustments, deductions);
    let brackets = single(); // needs to be choosen by the user, should be single(); or joint();
    bracket_application(income, &brackets)
}

