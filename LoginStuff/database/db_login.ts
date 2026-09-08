import { pool } from './db_con';

import { rl } from '../utils/readline';

export async function login() {
    const user = await rl.question('Enter your username: ');
    const pass = await rl.question('Enter your password: ');

    const log_bool = await pool.query('SELECT * FROM login_info WHERE Username = $1 AND Password = $2', [user, pass]);

    if (log_bool.rows.length > 0) {
        console.log('User found! Login successful.');
    } else {
        console.log('Invalid username or password.');
    }

}

export async function signup(){
    let email = " ";
    while (true){
        email = await rl.question('Enter your email: ');
        const match = await pool.query("SELECT username FROM login_info WHERE useremail = $1", [email]);
        if (match.rows.length > 0){
            console.log("That email is already registered!");
            continue;
        }
        if (email.includes("@gmail.com") || email.includes(".edu") || email.includes("@hotmail.com") || email.includes("@yahoo.com")){
            break;
        }
        console.log("Please enter a valid email");

    }

    let user = " ";

    while (true){
        user = await rl.question('Enter your username: ');
        const match = await pool.query("SELECT username FROM login_info WHERE username = $1", [user]);
        if (match.rows.length > 0){
            console.log("That username already exists!");
            continue;
        }
        break;
    }
    const pass = await rl.question('Enter your password: ');
    const passcheck = await rl.question('Confirm your password: ');

    if (pass === passcheck){
        console.log('Passwords are the same');
        await pool.query('INSERT INTO login_info (Username, Password, Useremail) VALUES ($1, $2, $3);', [user, pass, email]);
    }
    else{
        console.log("Passwords aren't the same");
    }
}

export async function showDB(){
    const db = await pool.query('SELECT * FROM login_info;');
    console.log(db.rows);
}
