"""Request and response models."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Sunlight = Literal["full_sun", "partial_shade", "shade"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginIn(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: int
    email: str
    display_name: str


class SessionOut(BaseModel):
    user: UserOut | None


class BedIn(StrictModel):
    name: str = Field(min_length=1, max_length=60)
    sunlight: Sunlight = "full_sun"
    notes: str = Field(default="", max_length=2000)


class BedOut(BaseModel):
    id: int
    name: str
    sunlight: Sunlight
    notes: str
    plant_count: int
    harvest_grams: int


class PlantIn(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    variety: str = Field(default="", max_length=80)
    bed_id: int = Field(gt=0)
    spacing_cm: int | None = Field(default=None, gt=0, le=1000)
    planted_on: date | None = None
    notes: str = Field(default="", max_length=4000)

    @field_validator("planted_on", mode="before")
    @classmethod
    def blank_date_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("spacing_cm", mode="before")
    @classmethod
    def blank_spacing_is_none(cls, value: object) -> object:
        return None if value == "" else value


class PlantOut(BaseModel):
    id: int
    name: str
    variety: str
    bed_id: int
    bed_name: str
    spacing_cm: int | None
    planted_on: date | None
    notes: str
    harvest_count: int
    harvest_grams: int
    created_at: str
    updated_at: str


class HarvestIn(StrictModel):
    plant_id: int = Field(gt=0)
    weight_grams: int = Field(gt=0, le=1_000_000)
    harvested_on: date
    notes: str = Field(default="", max_length=2000)

    @field_validator("harvested_on")
    @classmethod
    def not_in_future(cls, value: date) -> date:
        if value > date.today():
            raise ValueError("Harvest date cannot be in the future.")
        return value


class HarvestOut(BaseModel):
    id: int
    plant_id: int
    plant_name: str
    weight_grams: int
    harvested_on: date
    notes: str


class PlantDetailOut(PlantOut):
    harvests: list[HarvestOut]


class TaskIn(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    due_on: date


class TaskUpdate(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    due_on: date | None = None
    done: bool | None = None


class TaskOut(BaseModel):
    id: int
    title: str
    due_on: date
    done: bool
    done_at: str | None
    overdue: bool


class SummaryOut(BaseModel):
    year: int
    plant_count: int
    bed_count: int
    harvest_count_year: int
    harvest_grams_year: int
    open_task_count: int
    overdue_task_count: int
    top_plant: str | None
