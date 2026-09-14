// obviously no where near done lmao, just testing to make sure the rust menu shit is good

use std::io;

mod personal_income_tax;

fn main(){
    // should be a menu that accesses the different types of taxes
    println!("Lets get started on your tax income tax journey"); //obvious wip lmao
    
    let mut choice = String::new();
    
    io::stdin().read_line(&mut choice).unwrap();
    let choice: u32 = choice.trim().parse().unwrap();

    match choice{
        1 => personal_income_tax(),
        _=>println!("Invalid choice"),
    }
}

fn personal_income_tax(){
    // leads to income sources
}
