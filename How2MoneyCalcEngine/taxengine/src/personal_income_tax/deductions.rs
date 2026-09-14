// standard tax deductions and itemized taxes

pub struct Deductions{
    pub single: bool,
    // itemized deductions
    pub mortgage: f64,
    pub donations: f64,
    pub medical_expenses: f64,
}

pub fn totalDeductions(total: &Deductions) -> f64{
    total.single + total.mortgage + total.donations + total.medical_expenses
}
