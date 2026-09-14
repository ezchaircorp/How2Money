// all different types of income for the user

pub struct Taxpayer {
    pub wages: f64,
    pub self_employment_income: f64,
    pub other_income: f64,
}

pub fn total_income(taxpayer: &Taxpayer) -> f64{
    taxpayer.wages + taxpayer.self_employment_income + taxpayer.other_income
}


