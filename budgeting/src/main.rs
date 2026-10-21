//! Budgeter.
//!
//! The user enters what they spent this month per category whether it be manual or PDF input.
//!
//! We take the users salary and how much money they have currently to curate plan.
//!
//! For each category we compute how many SDs the user is above/below average
//! (the z-score). How far above average they're allowed to go depends on the
//! weight:
//!
//!     allowed SDs above average = BASE_TOLERANCE + weight * TOLERANCE_PER_WEIGHT
//!
//! With the defaults, weight 10 (Housing) may run 2.25 SD over before it's
//! flagged, while weight 1 (Gaming) gets flagged at just 0.45 SD over.
//! High-importance categories that are far *below* average get a gentle note,
//! since that can mean an essential spending is being neglected.

mod storage;

fn main(){

}


