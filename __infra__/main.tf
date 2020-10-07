provider "google-beta" {
    project  = "staterecords-197320"
}

terraform {
  backend "gcs" {
    bucket  = "tf-state-sr"
    prefix  = "terraform/state"
  }
}

module "cdn" {
  source        = "./modules/cdn"
  project_id    = "staterecords-197320"
  cdn_name      = "staterecords"
  managed_zone  = "staterecords"
  domain_name   = "cdn.staterecords.org."
}

module "regional-cluster" {
  source        = "./modules/regional-cluster"
  project_id    = "staterecords-197320"
  cluster_name  = "sr"
  location      = "us-central1"
}
/*
module "state" {
  source                 = "./modules/state"
  project_id             = "staterecords-197320"
  state_bucket_name      = "tf-state-sr"
}
*/
