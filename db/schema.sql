-- PodVet â€” isolated platform database schema.
-- This creates the platform DB (default: podvet) that hosts clinic id 1 and the
-- `clinics` metadata table. Each additional clinic gets its own database
-- (podvet_clinic_<id>) auto-created by the server based on this schema.
--
-- The plain `podvet` / `clinic_*` databases from other installs are NEVER
-- touched: this schema uses its own database name (DB_NAME, default "podvet")
-- and its own clinic prefix (CLINIC_PREFIX, default "podvet_clinic_").

CREATE DATABASE IF NOT EXISTS `podvet` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `podvet`;

-- â”€â”€ Platform-level tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE IF NOT EXISTS clinics (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    clinic_name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('OWNER','ADMIN','USER') DEFAULT 'USER',
    phone_number VARCHAR(50),
    clinic_id INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- â”€â”€ Clinic-level tables (clone target for podvet_clinic_<id>) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE IF NOT EXISTS clinic_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clinic_name VARCHAR(255),
    brand_color VARCHAR(20),
    logo_url VARCHAR(500),
    address TEXT,
    phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS branches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    branch_name VARCHAR(255) NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    address TEXT,
    phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_name VARCHAR(255) NOT NULL,
    contact_number VARCHAR(50),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id INT NOT NULL,
    pet_name VARCHAR(255) NOT NULL,
    sex ENUM('Male','Female','Unknown') DEFAULT 'Unknown',
    species VARCHAR(100) DEFAULT 'Dog',
    breed VARCHAR(255),
    color VARCHAR(100),
    date_of_birth DATE,
    age VARCHAR(50),
    is_neutered TINYINT(1) DEFAULT 0,
    is_microchipped TINYINT(1) DEFAULT 0,
    deceased TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    position VARCHAR(255),
    designation VARCHAR(255),
    salary DECIMAL(12,2) DEFAULT 0,
    contact VARCHAR(50),
    joined_on DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100) DEFAULT 'General',
    base_rate DECIMAL(12,2) DEFAULT 0,
    purchase_price DECIMAL(12,2) DEFAULT 0,
    is_grooming TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    barcode_number VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    price DECIMAL(12,2) DEFAULT 0,
    quantity INT DEFAULT 0,
    category VARCHAR(100),
    vendor_id INT,
    vendor_share_percentage DECIMAL(5,2) DEFAULT 0,
    vendor_credit_percent DECIMAL(5,2) DEFAULT 0,
    vendor_clinic_fixed_per_unit DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vendors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    contact_number VARCHAR(50),
    notes TEXT,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vendor_settlements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT,
    start_date DATE,
    end_date DATE,
    gross_sales DECIMAL(12,2) DEFAULT 0,
    vendor_share DECIMAL(12,2) DEFAULT 0,
    clinic_share DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS coupons (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type ENUM('PERCENT','FIXED') DEFAULT 'PERCENT',
    discount_value DECIMAL(12,2) DEFAULT 0,
    start_date DATE,
    expiry_date DATE,
    usage_limit INT DEFAULT 0,
    times_used INT DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expense_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category_id INT,
    amount DECIMAL(12,2) DEFAULT 0,
    date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    client_id INT NOT NULL,
    appointment_date DATE NOT NULL,
    appointment_time TIME,
    notes TEXT,
    status ENUM('CONFIRMED','CANCELLED','COMPLETED') DEFAULT 'CONFIRMED',
    doctor VARCHAR(255),
    branch_id INT,
    prediscount_type ENUM('PERCENT','FIXED') DEFAULT NULL,
    prediscount_value DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointment_services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NOT NULL,
    service_id INT,
    service_name VARCHAR(255),
    quantity INT DEFAULT 1,
    rate DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointment_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NOT NULL,
    product_id INT,
    quantity INT DEFAULT 1,
    price DECIMAL(12,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    locked TINYINT(1) DEFAULT 0,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT,
    client_id INT,
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    pet_name VARCHAR(255),
    subtotal DECIMAL(12,2) DEFAULT 0,
    discount DECIMAL(12,2) DEFAULT 0,
    final_total DECIMAL(12,2) DEFAULT 0,
    amount_paid DECIMAL(12,2) DEFAULT 0,
    status ENUM('PAID','UNPAID','PARTIALLY_PAID') DEFAULT 'UNPAID',
    payment_mode ENUM('CASH','CARD','BANK_TRANSFER') DEFAULT 'CASH',
    coupon_code VARCHAR(50),
    invoice_no VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    billing_id INT NOT NULL,
    product_id INT,
    name VARCHAR(255),
    quantity INT DEFAULT 1,
    price DECIMAL(12,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    FOREIGN KEY (billing_id) REFERENCES billing(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS soap_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    appointment_id INT,
    boarding_stay_id INT,
    doctor VARCHAR(255),
    subjective TEXT,
    objective TEXT,
    assessment TEXT,
    diagnosis TEXT,
    `plan` TEXT,
    temperature DECIMAL(5,2),
    heart_rate INT,
    respiratory_rate INT,
    weight DECIMAL(8,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vaccinations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    vaccine_name VARCHAR(255),
    administered_on DATE,
    next_due_date DATE,
    batch_number VARCHAR(100),
    notes TEXT,
    administered_by VARCHAR(255),
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dewormings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    product_name VARCHAR(255),
    administered_on DATE,
    next_due_date DATE,
    batch_number VARCHAR(100),
    notes TEXT,
    administered_by VARCHAR(255),
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prescriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    prescribed_by VARCHAR(255),
    prescribed_on DATE,
    notes TEXT,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prescription_medications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    prescription_id INT NOT NULL,
    name VARCHAR(255),
    dosage VARCHAR(255),
    frequency VARCHAR(255),
    duration VARCHAR(255),
    FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lab_test_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    test_name VARCHAR(255),
    test_date DATE,
    result_summary TEXT,
    result_value VARCHAR(255),
    reference_range VARCHAR(255),
    status VARCHAR(50),
    lab_name VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS procedures (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    procedure_name VARCHAR(255),
    performed_on DATE,
    performed_by VARCHAR(255),
    notes TEXT,
    outcome TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS procedure_materials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    procedure_id INT NOT NULL,
    product_id INT,
    material_name VARCHAR(255),
    quantity DECIMAL(12,2) DEFAULT 0,
    dose VARCHAR(255),
    route VARCHAR(255),
    batch_number VARCHAR(100),
    notes TEXT,
    FOREIGN KEY (procedure_id) REFERENCES procedures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS body_weight_records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    weight DECIMAL(8,2),
    weight_unit VARCHAR(20),
    recorded_on DATE,
    recorded_by VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lab_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    test_type VARCHAR(255),
    custom_test_type VARCHAR(255),
    file_url VARCHAR(1000),
    file_type VARCHAR(50),
    original_filename VARCHAR(500),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entity_type ENUM('appointment','pet') DEFAULT 'pet',
    entity_id INT,
    remind_on DATE,
    note TEXT,
    is_dismissed TINYINT(1) DEFAULT 0,
    due_date DATE,
    doctor VARCHAR(255),
    pet_name VARCHAR(255),
    client_name VARCHAR(255),
    contact_number VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    branch_id INT,
    thumbnail_url VARCHAR(1000),
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS form_pages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    form_id INT NOT NULL,
    page_index INT DEFAULT 0,
    image_url VARCHAR(1000),
    fields JSON,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cage_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    branch_id INT,
    type_name VARCHAR(255),
    is_free_area TINYINT(1) DEFAULT 0,
    quantity INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cage_units (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cage_type_id INT NOT NULL,
    unit_label VARCHAR(100),
    is_active TINYINT(1) DEFAULT 1,
    FOREIGN KEY (cage_type_id) REFERENCES cage_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    feeding_interval_minutes INT DEFAULT 480,
    monitoring_interval_minutes INT DEFAULT 60,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_stays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    branch_id INT,
    pet_id INT NOT NULL,
    client_id INT,
    cage_unit_id INT,
    service_id INT,
    date_in DATE,
    date_out DATE,
    expected_checkout_date DATE,
    status VARCHAR(50),
    purpose VARCHAR(255),
    hospitalization_purpose VARCHAR(255),
    requires_monitoring TINYINT(1) DEFAULT 0,
    notes TEXT,
    needs_vaccination TINYINT(1) DEFAULT 0,
    needs_deworming TINYINT(1) DEFAULT 0,
    owner_provides_food TINYINT(1) DEFAULT 0,
    feeding_interval_minutes INT DEFAULT 480,
    monitoring_interval_minutes INT DEFAULT 60,
    billing_id INT,
    amount_paid DECIMAL(12,2) DEFAULT 0,
    payment_mode VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_care_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    stay_id INT NOT NULL,
    log_type VARCHAR(50),
    logged_by VARCHAR(255),
    notes TEXT,
    product_id INT,
    item_name VARCHAR(255),
    display_name VARCHAR(255),
    quantity DECIMAL(12,2) DEFAULT 0,
    price DECIMAL(12,2) DEFAULT 0,
    medication_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stay_id) REFERENCES boarding_stays(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_medications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    stay_id INT NOT NULL,
    drug_name VARCHAR(255),
    dose VARCHAR(255),
    interval_minutes INT,
    product_id INT,
    quantity DECIMAL(12,2) DEFAULT 0,
    price DECIMAL(12,2) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    started_at DATETIME,
    discontinued_at DATETIME,
    FOREIGN KEY (stay_id) REFERENCES boarding_stays(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- â”€â”€ Seed data (safe to re-run) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

INSERT INTO clinics (id, clinic_name, slug) VALUES (1, 'PodVet Clinic', 'podvet')
ON DUPLICATE KEY UPDATE slug = VALUES(slug);

INSERT INTO clinic_settings (id, clinic_name, brand_color) VALUES (1, 'PodVet Clinic', '#92CAED')
ON DUPLICATE KEY UPDATE clinic_name = VALUES(clinic_name), brand_color = VALUES(brand_color);

-- Default admin user (node-bcrypt password: admin123)
INSERT INTO users (name, username, email, password, role, clinic_id) VALUES
('Admin', 'admin', 'admin@podvet.local', '$2b$10$yWrBrWrfu9d0PrtIvh9rT.KBG8CPmoPOQyb.IxYYlIX7vtgcR/iuG', 'OWNER', 1)
ON DUPLICATE KEY UPDATE username = VALUES(username);

INSERT INTO branches (branch_name, is_active) VALUES ('Main Branch', 1);

INSERT INTO expense_categories (name, description) VALUES
('Rent', 'Office/clinic rent'),
('Utilities', 'Electricity, water, internet'),
('Supplies', 'Medical and office supplies'),
('Salary', 'Employee salaries'),
('Maintenance', 'Equipment and facility maintenance'),
('Other', 'Miscellaneous expenses');

INSERT INTO services (name, category, base_rate) VALUES
('Consultation', 'General', 500),
('Vaccination', 'Medical', 800),
('Surgery', 'Medical', 5000),
('Grooming - Basic', 'Grooming', 300),
('Grooming - Premium', 'Grooming', 600),
('Deworming', 'Medical', 400),
('Lab Test', 'Laboratory', 1200),
('X-Ray', 'Laboratory', 2500),
('Boarding - Standard', 'Boarding', 500),
('Boarding - Premium', 'Boarding', 800);