CREATE DATABASE IF NOT EXISTS foodapp;
USE foodapp;

-- Restaurants table
CREATE TABLE IF NOT EXISTS restaurants (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  cuisine       VARCHAR(50),
  rating        DECIMAL(2,1),
  delivery_time INT,
  min_order     DECIMAL(8,2) DEFAULT 99.00,
  image_url     VARCHAR(255),
  address       VARCHAR(255),
  is_open       TINYINT(1) DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Menu items table
CREATE TABLE IF NOT EXISTS menu_items (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  name          VARCHAR(100) NOT NULL,
  price         DECIMAL(8,2) NOT NULL,
  description   TEXT,
  category      VARCHAR(50) DEFAULT 'Main',
  image_url     VARCHAR(255),
  is_veg        TINYINT(1) DEFAULT 0,
  is_available  TINYINT(1) DEFAULT 1,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT,
  restaurant_id INT,
  total         DECIMAL(10,2) NOT NULL,
  status        ENUM('pending','confirmed','preparing','out_for_delivery','delivered','cancelled') DEFAULT 'pending',
  delivery_addr VARCHAR(255),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_id INT NOT NULL,
  user_name     VARCHAR(100) DEFAULT 'Anonymous',
  rating        TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

-- ── Seed Data ──────────────────────────────────────────────────────────────────
INSERT IGNORE INTO restaurants (id, name, cuisine, rating, delivery_time, min_order, address, image_url) VALUES
(1, 'Spice Garden',  'Indian',    4.5, 30, 149, '12 MG Road, Bengaluru', '/images/spice-garden.jpg'),
(2, 'Pizza House',   'Italian',   4.2, 25,  99, '45 Church Street, Bengaluru', '/images/pizza-house.jpg'),
(3, 'Burger Barn',   'American',  4.0, 20,  79, '7 Brigade Road, Bengaluru', '/images/burger-barn.jpg'),
(4, 'Sushi Sensei',  'Japanese',  4.7, 40, 249, '9 Indiranagar, Bengaluru', '/images/sushi-sensei.jpg'),
(5, 'Biryani Blues', 'Indian',    4.6, 35, 199, '22 Koramangala, Bengaluru', '/images/biryani.jpg'),
(6, 'The Wok',       'Chinese',   4.1, 28, 129, '5 Whitefield, Bengaluru', '/images/the-wok.jpg');

INSERT IGNORE INTO menu_items (restaurant_id, name, price, description, category, is_veg) VALUES
-- Spice Garden
(1, 'Butter Chicken',      320, 'Tender chicken in rich tomato-butter sauce', 'Main', 0),
(1, 'Dal Makhani',         220, 'Slow-cooked black lentils with cream', 'Main', 1),
(1, 'Garlic Naan',          60, 'Soft leavened bread with garlic butter', 'Bread', 1),
(1, 'Mango Lassi',          80, 'Sweet yogurt drink with fresh mango', 'Beverage', 1),
(1, 'Paneer Tikka',        280, 'Grilled cottage cheese with spiced marinade', 'Starter', 1),
-- Pizza House
(2, 'Margherita Pizza',    349, 'Classic tomato, mozzarella and basil', 'Pizza', 1),
(2, 'Chicken BBQ Pizza',   449, 'Grilled chicken, BBQ sauce, onions', 'Pizza', 0),
(2, 'Pasta Arrabbiata',    299, 'Penne in spicy tomato sauce', 'Pasta', 1),
(2, 'Tiramisu',            189, 'Classic Italian dessert', 'Dessert', 1),
-- Burger Barn
(3, 'Classic Cheeseburger',199, 'Beef patty, cheddar, lettuce, tomato', 'Burger', 0),
(3, 'Veggie Burger',       169, 'Black bean patty with avocado', 'Burger', 1),
(3, 'Loaded Fries',        129, 'Crispy fries with cheese sauce & jalapeños', 'Sides', 1),
(3, 'Milkshake',           149, 'Thick shake — chocolate, vanilla or strawberry', 'Beverage', 1),
-- Sushi Sensei
(4, 'Salmon Nigiri (8pc)', 499, 'Fresh Atlantic salmon over seasoned rice', 'Sushi', 0),
(4, 'Spicy Tuna Roll',     449, 'Tuna, cucumber, sriracha mayo', 'Roll', 0),
(4, 'Edamame',             199, 'Steamed salted soybeans', 'Starter', 1),
-- Biryani Blues
(5, 'Chicken Biryani',     299, 'Fragrant basmati rice with spiced chicken', 'Main', 0),
(5, 'Mutton Biryani',      379, 'Slow-cooked mutton biryani', 'Main', 0),
(5, 'Veg Biryani',         249, 'Mixed vegetables in basmati rice', 'Main', 1),
(5, 'Raita',                49, 'Chilled yogurt with cucumber', 'Sides', 1),
-- The Wok
(6, 'Kung Pao Chicken',    299, 'Stir-fried chicken with peanuts & chilies', 'Main', 0),
(6, 'Veg Fried Rice',      199, 'Wok-tossed rice with mixed vegetables', 'Rice', 1),
(6, 'Spring Rolls (6pc)',  149, 'Crispy vegetable spring rolls', 'Starter', 1),
(6, 'Hakka Noodles',       229, 'Stir-fried noodles with soy & veggies', 'Noodles', 1);

INSERT IGNORE INTO reviews (restaurant_id, user_name, rating, comment) VALUES
(1, 'Priya S.',    5, 'Best butter chicken in the city!'),
(1, 'Rahul M.',    4, 'Great food, slightly slow delivery.'),
(2, 'Aditya K.',   5, 'Authentic Italian taste. Loved the tiramisu!'),
(3, 'Sneha R.',    4, 'Burgers are juicy and fresh.'),
(5, 'Mohammed A.', 5, 'The biryani is absolutely amazing. Will order again!');
