resource "google_sql_database_instance" "phone" {
    database_version              = "MYSQL_5_7"
    name                          = "phone"
    project                       = "staterecords-197320"
    region                        = "us-central1"

    settings {
        activation_policy           = "ALWAYS"
        disk_autoresize             = true
        disk_size                   = 10
        disk_type                   = "PD_SSD"
        pricing_plan                = "PER_USE"
        tier                        = "db-custom-1-3840"

        backup_configuration {
            binary_log_enabled = true
            enabled            = true
            start_time         = "17:00"
        }

        ip_configuration {
            ipv4_enabled = true
            require_ssl  = false

            authorized_networks {
                name  = "all"
                value = "0.0.0.0/0"
            }
        }

        location_preference {
            zone = "us-central1-a"
        }
        maintenance_window {
            day  = 7
            hour = 0
        }

    }

    timeouts {}
}

resource "google_sql_user" "users" {
  name     = "intermedium"
  instance = google_sql_database_instance.phone.name
  password = "intermedium"
  project = "staterecords-197320"
}

resource "google_sql_database" "database" {
  name     = "california"
  instance = google_sql_database_instance.phone.name
  project = "staterecords-197320"
}

resource "google_sql_database" "florida" {
  name     = "florida"
  instance = google_sql_database_instance.phone.name
  project = "staterecords-197320"
}

resource "google_sql_database" "utah" {
  name     = "utah"
  instance = google_sql_database_instance.phone.name
  project = "staterecords-197320"
}

resource "google_sql_database" "maryland" {
  name     = "maryland"
  instance = google_sql_database_instance.phone.name
  project = "staterecords-197320"
}

resource "google_sql_database_instance" "staterecords-pg" {
    database_version              = "POSTGRES_9_6"
    name                          = "staterecords-pg"
    project                       = "staterecords-197320"
    region                        = "us-central1"

    settings {
        activation_policy           = "ALWAYS"
        availability_type           = "ZONAL"
        disk_autoresize             = true
        disk_size                   = 10
        disk_type                   = "PD_SSD"
        pricing_plan                = "PER_USE"
        tier                        = "db-custom-1-3840"

        backup_configuration {
            binary_log_enabled = false
            enabled            = true
            start_time         = "20:00"
        }

        ip_configuration {
            ipv4_enabled = true
            require_ssl  = false

            authorized_networks {
                value = "0.0.0.0/0"
            }
            authorized_networks {
                name  = "sr-instance"
                value = "104.154.33.119"
            }
        }

        location_preference {
            zone = "us-central1-b"
        }

        maintenance_window {
            day  = 7
            hour = 0
        }
    }

    timeouts {}
}
