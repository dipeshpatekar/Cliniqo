use app_lib::updater::AppUpdater;
use std::env;
use std::fs;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: verify_installer <installer_path> <signature_path_or_content>");
        std::process::exit(1);
    }

    let installer_path = &args[1];
    let sig_input = &args[2];

    let bytes = match fs::read(installer_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Failed to read installer at {installer_path}: {e}");
            std::process::exit(2);
        }
    };

    let sig_str = if fs::metadata(sig_input).is_ok() {
        match fs::read_to_string(sig_input) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to read signature file at {sig_input}: {e}");
                std::process::exit(3);
            }
        }
    } else {
        sig_input.clone()
    };

    match AppUpdater::verify_installer_signature(&bytes, &sig_str) {
        Ok(()) => {
            println!("Signature verified successfully against embedded Minisign public key.");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("Signature verification failed: {e:?}");
            std::process::exit(4);
        }
    }
}
