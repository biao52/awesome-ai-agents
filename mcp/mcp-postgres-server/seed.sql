-- Seed data for MCP Postgres Server example
-- Creates sample tables and populates them with test data.

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    in_stock BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    customer_email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Products (15 rows)
INSERT INTO products (name, price, category, in_stock) VALUES
    ('Mechanical Keyboard', 149.99, 'Electronics', true),
    ('USB-C Hub', 49.99, 'Electronics', true),
    ('Standing Desk', 599.00, 'Furniture', true),
    ('Monitor Arm', 89.99, 'Furniture', true),
    ('Noise Cancelling Headphones', 299.99, 'Electronics', true),
    ('Ergonomic Mouse', 79.99, 'Electronics', false),
    ('Desk Lamp', 45.00, 'Furniture', true),
    ('Webcam HD', 129.99, 'Electronics', true),
    ('Cable Management Kit', 24.99, 'Accessories', true),
    ('Laptop Stand', 59.99, 'Accessories', true),
    ('Wireless Charger', 34.99, 'Electronics', false),
    ('Desk Pad', 29.99, 'Accessories', true),
    ('Monitor Light Bar', 69.99, 'Electronics', true),
    ('Footrest', 44.99, 'Furniture', true),
    ('Screen Cleaner', 12.99, 'Accessories', true);

-- Orders (12 rows)
INSERT INTO orders (product_id, quantity, customer_email, created_at) VALUES
    (1, 2, 'alice@example.com', '2025-01-15 10:30:00'),
    (3, 1, 'bob@example.com', '2025-01-16 14:22:00'),
    (5, 1, 'carol@example.com', '2025-02-01 09:15:00'),
    (2, 3, 'alice@example.com', '2025-02-05 16:45:00'),
    (8, 1, 'dave@example.com', '2025-02-10 11:00:00'),
    (1, 1, 'eve@example.com', '2025-03-01 13:30:00'),
    (10, 2, 'bob@example.com', '2025-03-12 08:20:00'),
    (4, 1, 'carol@example.com', '2025-03-15 17:10:00'),
    (7, 1, 'frank@example.com', '2025-04-01 10:00:00'),
    (13, 2, 'alice@example.com', '2025-04-10 15:45:00'),
    (9, 4, 'dave@example.com', '2025-04-20 12:30:00'),
    (15, 3, 'eve@example.com', '2025-05-01 09:00:00');
