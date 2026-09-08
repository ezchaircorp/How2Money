// main menu

import { pool } from './db_con';

import { login, signup, showDB} from './db_login';

import { rl } from '../utils/readline';

export async function main(){
    let running = true;
    while (running) {
        const choice = await rl.question('1. Login \n2. Sign up\n\n');
        switch (choice){
            case '1':
                await login();
                break;
            case '2':
                await signup();
                break;
            case '3':
                await showDB();
                break;
            case 'exit':
                running = false;
                break;
            default:
                console.log('Invalid choice');
        }
    }
    rl.close();
    await pool.end();
}

main();
