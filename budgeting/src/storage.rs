//! Storage for the budgeting database, never writes only reads
//!
//! Category weights are also stored so there is no database round
//! trip to look up the weights, saves time.

use chrono::{Months, NaiveDate};
use sqlx::{
    postgres::{PgConnectOptions, PgPoolOptions},
    FromRow, PgPool,
};
use std::{fmt, ops::Index, str::FromStr};

/// Money is always whole cents. Never use f64 for money.
pub type Cents = i64;