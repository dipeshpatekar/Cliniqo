use app_lib::auth::SessionManager;
use serde::Deserialize;
use std::io::{self, Read};

#[derive(Deserialize)]
struct VerifyInput {
    public_key_pem: String,
    token: String,
    clinic_id: String,
    role: String,
}

fn main() {
    let mut buffer = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buffer) {
        eprintln!("Failed to read stdin: {e}");
        std::process::exit(1);
    }

    let input: VerifyInput = match serde_json::from_str(&buffer) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("Invalid input JSON: {e}");
            std::process::exit(2);
        }
    };

    let session_mgr = match SessionManager::new(&input.public_key_pem) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("SessionManager initialization error: {e}");
            std::process::exit(3);
        }
    };

    match session_mgr.login(&input.token, &input.clinic_id, &input.role) {
        Ok(session) => {
            let output = serde_json::json!({
                "success": true,
                "session": session,
            });
            println!("{output}");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("Login failed: {e}");
            std::process::exit(4);
        }
    }
}
